/**
 * On-disk store for the main process: the library JSON, the binary waveform
 * caches, and tag reading for imports.
 *
 * Everything lives under `app.getPath('userData')`:
 *
 * ```
 * library.json            LibraryFile, written atomically
 * waveforms/<audioKey>.djw three-band waveform cache, format in ARCHITECTURE.md
 * ```
 *
 * Only local records are stored. The rekordbox mirror is rebuilt from the XML
 * export on every sync (see `rekordboxSync.ts`); all this file keeps of it is
 * the remembered path of that export.
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve as resolvePath } from 'node:path'
import { app } from 'electron'
import { parseFile } from 'music-metadata'
import type { IAudioMetadata, IPicture } from 'music-metadata'
import type { LibraryFile, Track } from '@shared/types'
import { localIdFor } from '@shared/collection'

/**
 * Mirrors `LIBRARY_VERSION` in `renderer/src/core/constants.ts`. Main cannot
 * import renderer code, so the constant is duplicated here; bump both together.
 */
const LIBRARY_VERSION = 1

/**
 * Artwork is inlined into library.json as a data: URL, so a 4000x4000 cover
 * would bloat the file and slow every load. Bigger art is simply dropped.
 */
const MAX_ARTWORK_BYTES = 512 * 1024

/** Cache keys are used as file names, so anything else is refused outright. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Library writes are chained, never concurrent, so renames land in call order.
 * `whenLibraryIdle` waits on the chain when the app is quitting.
 */
let libraryWrites: Promise<void> = Promise.resolve()

/** Track ids the library held at the last successful read or write. */
let knownTrackIds: Set<string> | null = null

/**
 * The remembered rekordbox XML export, as last read from or written to disk.
 *
 * Owned by main. The field on an incoming library save is ignored: it carries
 * whatever the renderer loaded at startup.
 */
let rememberedXmlPath: string | null = null

function userDataPath(...parts: string[]): string {
  // Resolved per call: `app.getPath` is only valid once Electron has started.
  return join(app.getPath('userData'), ...parts)
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isMissingFile(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Copy a Node buffer into a standalone ArrayBuffer. Buffers are views onto a
 * shared pool, so handing `.buffer` straight to the renderer would expose
 * unrelated bytes and confuse `decodeAudioData` about the real length.
 */
export function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buf.byteLength)
  new Uint8Array(out).set(buf)
  return out
}

/**
 * Write via a sibling temp file and rename, which is atomic within a
 * filesystem: an interrupted write leaves the previous file intact.
 */
async function writeFileAtomic(target: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, data)
    await rename(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/**
 * Stable id for a file: the SHA-1 of its absolute path. Re-importing a file is
 * instant and lands on the analysis and waveform cache already written for it.
 */
export function trackIdForPath(path: string): string {
  return createHash('sha1').update(resolvePath(path)).digest('hex')
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function artworkDataUrl(pictures: IPicture[] | undefined): string | null {
  const pic = pictures?.find((p) => p.data.byteLength > 0 && p.data.byteLength <= MAX_ARTWORK_BYTES)
  if (!pic) return null
  // Some taggers store a bare subtype ('jpeg') where a MIME type belongs.
  const format = pic.format?.trim() || 'image/jpeg'
  const mime = format.includes('/') ? format : `image/${format}`
  return `data:${mime};base64,${Buffer.from(pic.data).toString('base64')}`
}

function trackFromMetadata(audioKey: string, path: string, meta: IAudioMetadata): Track {
  const { common, format } = meta
  const comments = (common.comment ?? [])
    .map((c) => c.text?.trim())
    .filter((t): t is string => !!t)

  return {
    // A file imported here is a local record from the start; only the rekordbox
    // mirror uses the other namespace.
    id: localIdFor(audioKey),
    source: 'local',
    audioKey,
    path,
    title: nonEmpty(common.title) ?? basename(path, extname(path)),
    artist: nonEmpty(common.artist) ?? 'Unknown Artist',
    album: nonEmpty(common.album) ?? '',
    genre: (common.genre ?? []).map((g) => g.trim()).filter(Boolean).join(', '),
    comment: comments.join(' / '),
    durationSec: format.duration ?? 0,
    sampleRate: format.sampleRate ?? 44100,
    channels: format.numberOfChannels ?? 2,
    // Tag tempo and key are a starting point only; analysis overwrites bpm and
    // sets the grid, and neither field is trusted for beat matching.
    bpm: typeof common.bpm === 'number' && isFinite(common.bpm) && common.bpm > 0 ? common.bpm : null,
    key: nonEmpty(common.key),
    grid: null,
    hotCues: [],
    memoryCues: [],
    cuePoint: null,
    rating: 0,
    color: null,
    dateAdded: Date.now(),
    analyzed: false,
    artwork: artworkDataUrl(common.picture)
  }
}

/**
 * Read tags for each path and build a fresh Track record. A file that cannot be
 * parsed is skipped and logged; the rest of the import goes through.
 */
export async function importPaths(paths: string[]): Promise<Track[]> {
  const tracks: Track[] = []
  const seen = new Set<string>()

  for (const raw of paths) {
    const path = resolvePath(raw)
    const audioKey = trackIdForPath(path)
    if (seen.has(audioKey)) continue
    seen.add(audioKey)

    try {
      // `duration: true` makes music-metadata scan the frames when the header
      // has no reliable length, which is the common case for VBR MP3s.
      const meta = await parseFile(path, { duration: true })
      tracks.push(trackFromMetadata(audioKey, path, meta))
    } catch (err) {
      console.warn(`[library] skipped unreadable file ${path}: ${describeError(err)}`)
    }
  }

  return tracks
}

function emptyLibrary(): LibraryFile {
  return { version: LIBRARY_VERSION, tracks: [] }
}

function trackIdSet(tracks: readonly Track[]): Set<string> {
  const ids = new Set<string>()
  for (const t of tracks) {
    if (typeof t?.id === 'string') ids.add(t.id)
  }
  return ids
}

async function readLibraryFile(path: string): Promise<LibraryFile> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (!isMissingFile(err)) console.warn(`[library] could not read ${path}: ${describeError(err)}`)
    return emptyLibrary()
  }

  try {
    const parsed = JSON.parse(text) as Partial<LibraryFile> | null
    if (!parsed || !Array.isArray(parsed.tracks)) throw new Error('no tracks array')
    return {
      version: typeof parsed.version === 'number' ? parsed.version : LIBRARY_VERSION,
      tracks: parsed.tracks,
      // Missing in every library written before rekordbox sync existed, and
      // missing again after the user clears it.
      rekordboxXmlPath:
        typeof parsed.rekordboxXmlPath === 'string' && parsed.rekordboxXmlPath
          ? parsed.rekordboxXmlPath
          : undefined
    }
  } catch (err) {
    // Keep the damaged file aside for recovery by hand. The app starts either
    // way.
    console.error(`[library] ${path} is corrupt (${describeError(err)}), starting empty`)
    await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => undefined)
    return emptyLibrary()
  }
}

/** Read library.json. A missing, unreadable or corrupt file yields an empty library. */
export async function loadLibrary(): Promise<LibraryFile> {
  const lib = await readLibraryFile(userDataPath('library.json'))
  // Remember the collection as it was loaded so the first save after a removal
  // can already tell which track left and drop its waveform cache.
  knownTrackIds = trackIdSet(lib.tracks)
  rememberedXmlPath = lib.rekordboxXmlPath ?? null
  return lib
}

async function persistLibrary(payload: LibraryFile): Promise<void> {
  await writeFileAtomic(userDataPath('library.json'), JSON.stringify(payload))
  await pruneWaveformCaches(trackIdSet(payload.tracks))
}

/**
 * Persist the library. Writes are serialised, and the returned promise settles
 * only once this snapshot is on disk, which is what a quit waits for.
 */
export function saveLibrary(lib: LibraryFile): Promise<void> {
  const payload: LibraryFile = {
    version: lib.version || LIBRARY_VERSION,
    tracks: lib.tracks ?? [],
    rekordboxXmlPath: rememberedXmlPath ?? undefined
  }

  const write = libraryWrites.then(() => persistLibrary(payload))
  // A failed write must not poison the chain for the writes queued behind it.
  // The caller still sees the failure through `write` itself.
  libraryWrites = write.catch(() => undefined)
  return write
}

/** The rekordbox XML export to watch, or null if none has been chosen. */
export function getRekordboxXmlPath(): string | null {
  return rememberedXmlPath
}

/**
 * Remember (or, with null, forget) the rekordbox XML export and persist it.
 *
 * The only write main makes on its own. The tracks are re-read from disk, since
 * the renderer holds the collection.
 */
export function setRekordboxXmlPath(path: string | null): Promise<void> {
  rememberedXmlPath = path

  const write = libraryWrites.then(async () => {
    const current = await readLibraryFile(userDataPath('library.json'))
    // `null` is written out, not dropped. It tells the next launch the user
    // disconnected, and auto-detection leaves the default location alone.
    await persistLibrary({ ...current, rekordboxXmlPath: path })
  })
  libraryWrites = write.catch(() => undefined)
  return write
}

/**
 * Resolve once no library write is outstanding.
 *
 * The renderer posts its final save as the page tears down, so that message can
 * still be sitting in main's IPC queue when the window is already gone. An idle
 * check made at that instant would report "nothing pending" and let the process
 * exit over the top of the user's last hot cue, so yield a full event-loop turn
 * first and let any queued save join the chain.
 */
export async function whenLibraryIdle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  let awaited: Promise<void> | null = null
  while (awaited !== libraryWrites) {
    awaited = libraryWrites
    await awaited
  }
}

/**
 * Cache path for an audio key, or null if the key could not be a file name.
 *
 * Keyed on the audio, not on the track, so a local fork of a mirrored record
 * lands on the analysis already done for the identical file. A local id is its
 * audio key, which is what lets {@link pruneWaveformCaches} work off the ids in
 * the saved collection.
 */
function waveformCachePath(audioKey: string): string | null {
  return SAFE_ID.test(audioKey) ? userDataPath('waveforms', `${audioKey}.djw`) : null
}

/**
 * Drop the caches of tracks that have left the collection.
 *
 * Nothing but the library refers to a .djw, so a removed track would strand its
 * cache in <userData>/waveforms for good and the directory would only ever
 * grow. Diffing each saved snapshot against the previous one catches every way
 * a track can leave without scanning the directory. Paths still come from
 * `waveformCachePath`, so an id that could not be written cannot be deleted
 * through either.
 */
async function pruneWaveformCaches(ids: Set<string>): Promise<void> {
  const previous = knownTrackIds
  knownTrackIds = ids
  if (!previous) return

  for (const id of previous) {
    if (ids.has(id)) continue
    const path = waveformCachePath(id)
    if (!path) continue
    try {
      await rm(path, { force: true })
    } catch (err) {
      console.warn(`[library] could not remove ${path}: ${describeError(err)}`)
    }
  }
}

/** Cached .djw bytes for an audio key, or null when nothing has been analysed yet. */
export async function readWaveformCache(audioKey: string): Promise<ArrayBuffer | null> {
  const path = waveformCachePath(audioKey)
  if (!path) return null

  try {
    return toArrayBuffer(await readFile(path))
  } catch (err) {
    if (!isMissingFile(err)) console.warn(`[library] could not read ${path}: ${describeError(err)}`)
    return null
  }
}

export async function writeWaveformCache(audioKey: string, data: ArrayBuffer): Promise<void> {
  const path = waveformCachePath(audioKey)
  if (!path) throw new Error(`Refusing to write a waveform cache for audio key "${audioKey}"`)
  await writeFileAtomic(path, Buffer.from(data))
}
