/**
 * The rekordbox mirror.
 *
 * rekordbox keeps its live library in an encrypted database, so the XML export
 * is the only thing DJDaw can safely read. This module rebuilds the whole
 * mirror from that file on every sync — nothing is persisted and nothing is
 * merged — which is what makes the mirror honest: whatever the last export
 * said is exactly what the user sees, deletions included.
 *
 * rekordbox 7 can write this file itself (Preferences > Auto Export, which
 * fires when rekordbox quits), and it is also written by a manual File >
 * Export Collection in xml format. The UI has to say so; this module cannot
 * make the data any fresher than the user's last export.
 */

import { homedir } from 'node:os'
import { existsSync, statSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import type { RekordboxPlaylistRef, RekordboxSyncResult, Track } from '@shared/types'
import { parseRekordboxXml } from '@shared/rekordboxXml'
import { trackFromRekordbox } from '@shared/rekordboxImport'
import { trackIdForPath } from './library'

/**
 * One export writes the file in several steps, so the watcher sees a burst of
 * events. Waiting for the burst to go quiet means one sync per export, and it
 * also keeps a half-written file from being parsed.
 */
const DEBOUNCE_MS = 600

/** Serialises syncs; see {@link syncFromXml}. */
let pendingSync: Promise<unknown> = Promise.resolve()

let watcher: FSWatcher | null = null
let watchedPath: string | null = null
let debounce: NodeJS.Timeout | null = null
/** Modification time of the export as of the last event we acted on. */
let lastSeenMtimeMs = 0

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A mirror with nothing in it: no export chosen, or one that could not be read. */
/**
 * Where rekordbox writes its collection export by default.
 *
 * rekordbox's Auto Export (Preferences > Advanced > Other) fills the
 * destination in for you, and on macOS that default sits beside the rest of its
 * data. Checking here means a first launch finds the collection with nothing
 * for the user to pick. Returns null on platforms whose location we have not
 * confirmed, rather than guessing.
 */
export function defaultRekordboxXmlPath(): string | null {
  if (process.platform !== 'darwin') return null
  return join(homedir(), 'Library', 'Pioneer', 'rekordbox', 'rekordbox.xml')
}

export function emptyMirror(xmlPath: string | null, error?: string): RekordboxSyncResult {
  return {
    xmlPath,
    producedBy: '',
    tracks: [],
    missingPaths: [],
    playlists: [],
    syncedAt: 0,
    ...(error ? { error } : {})
  }
}

/** Modification time in ms, or 0 when the file cannot be reached. */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

async function readMirror(xmlPath: string): Promise<RekordboxSyncResult> {
  // `syncedAt` is the export's own timestamp, not now: it is the only thing
  // that tells the user how stale the mirror actually is.
  const info = await stat(xmlPath)
  const collection = parseRekordboxXml(await readFile(xmlPath, 'utf8'))

  const tracks: Track[] = []
  const missingPaths: string[] = []
  const idMap: Record<string, string> = {}

  for (const entry of collection.tracks) {
    if (!entry.path) continue
    const track = trackFromRekordbox(entry, trackIdForPath(entry.path), 'rekordbox')
    idMap[entry.trackId] = track.id
    // A collection on an unmounted external drive still belongs in the mirror,
    // the way rekordbox keeps it, but the count must not be silently short.
    if (!existsSync(entry.path)) missingPaths.push(entry.path)
    tracks.push(track)
  }

  const playlists: RekordboxPlaylistRef[] = collection.playlists.map((p) => ({
    name: p.name,
    folders: p.folders,
    trackIds: p.trackIds.map((rbId) => idMap[rbId]).filter((v): v is string => Boolean(v))
  }))

  return {
    xmlPath,
    producedBy: collection.producedBy,
    tracks,
    missingPaths,
    playlists,
    syncedAt: info.mtimeMs
  }
}

/**
 * Rebuild the mirror from an XML export.
 *
 * Never rejects: a moved, deleted or malformed export resolves with an empty
 * mirror and an `error` string instead, because this runs at startup and a
 * stale remembered path must not be able to stop the app from launching.
 *
 * Calls are serialised. A burst of file events plus a manual refresh could
 * otherwise have two parses of a multi-megabyte collection running at once,
 * and the older one could finish last and push the staler mirror.
 */
export function syncFromXml(xmlPath: string): Promise<RekordboxSyncResult> {
  const run = async (): Promise<RekordboxSyncResult> => {
    try {
      return await readMirror(xmlPath)
    } catch (err) {
      console.warn(`[rekordbox] sync failed for ${xmlPath}: ${describeError(err)}`)
      return emptyMirror(xmlPath, describeError(err))
    }
  }

  const next = pendingSync.then(run, run)
  pendingSync = next.catch(() => undefined)
  return next
}

function handleChange(onChange: (result: RekordboxSyncResult) => void): void {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => {
    debounce = null
    const path = watchedPath
    if (!path) return

    // An export fires several events, and editors and backup tools touch the
    // directory for their own reasons. If the export itself has not been
    // rewritten there is nothing to re-read.
    const mtime = mtimeOf(path)
    if (mtime !== 0 && mtime === lastSeenMtimeMs) return
    lastSeenMtimeMs = mtime

    void syncFromXml(path).then((result) => {
      // A stop that landed while the parse was running means nobody wants this.
      if (watchedPath === path) onChange(result)
    })
  }, DEBOUNCE_MS)
}

/**
 * Watch an XML export and call `onChange` with a fresh mirror after each write.
 *
 * The watch is on the containing directory, filtered to the file name, because
 * rekordbox exports by replacing the file rather than rewriting it in place. A
 * watch on the file itself follows the old inode and goes deaf after the very
 * first export, which looks exactly like sync silently not working.
 *
 * Replaces any existing watch. Does not sync immediately — the caller decides
 * whether it wants the initial mirror.
 */
export function startWatching(
  xmlPath: string,
  onChange: (result: RekordboxSyncResult) => void
): void {
  stopWatching()

  const path = resolvePath(xmlPath)
  const name = basename(path)
  watchedPath = path
  lastSeenMtimeMs = mtimeOf(path)

  try {
    watcher = watch(dirname(path), (_event, filename) => {
      // Only macOS and Windows report a filename reliably; without one all we
      // know is "something in here changed", which the mtime check filters.
      const changed = typeof filename === 'string' ? basename(filename) : null
      if (changed !== null && changed !== name) return
      handleChange(onChange)
    })
    watcher.on('error', (err) => {
      console.warn(`[rekordbox] watch failed for ${path}: ${describeError(err)}`)
      stopWatching()
    })
  } catch (err) {
    console.warn(`[rekordbox] could not watch ${path}: ${describeError(err)}`)
    watcher = null
    watchedPath = null
  }
}

/** Stop watching. Safe to call when nothing is being watched. */
export function stopWatching(): void {
  if (debounce) {
    clearTimeout(debounce)
    debounce = null
  }
  watcher?.close()
  watcher = null
  watchedPath = null
  lastSeenMtimeMs = 0
}
