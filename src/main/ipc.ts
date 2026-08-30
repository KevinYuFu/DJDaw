/**
 * IPC surface behind `window.api`. One `ipcMain.handle` per method of the
 * `DJDawApi` contract in docs/ARCHITECTURE.md; the channel names here and in
 * `preload/index.ts` are the only place the two sides have to agree.
 *
 * `rekordbox:sync` is the exception: it goes the other way, pushed to the
 * renderer whenever the watched XML export is rewritten.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type {
  ExportRequest,
  ExportResult,
  LibraryFile,
  RekordboxImportResult,
  RekordboxSyncResult,
  Track
} from '@shared/types'
import { parseRekordboxXml } from '@shared/rekordboxXml'
import { trackFromRekordbox } from '@shared/rekordboxImport'
import { exportAudio } from './export'
import {
  getRekordboxXmlPath,
  importPaths,
  loadLibrary,
  readWaveformCache,
  saveLibrary,
  setRekordboxXmlPath,
  toArrayBuffer,
  trackIdForPath,
  writeWaveformCache
} from './library'
import {
  defaultRekordboxXmlPath,
  emptyMirror,
  startWatching,
  stopWatching,
  syncFromXml
} from './rekordboxSync'
import { transcodeArgs } from '@shared/ffmpegArgs'
import { cachedStems, readStemModel, writeStems } from './stems'
import type { StemName } from '@shared/stems'

/** Extensions offered by the import dialog. */
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'aiff', 'aif', 'ogg', 'opus', 'wma']

/** Formats Chromium cannot decode go through this, so it must exist on PATH. */
const FFMPEG_BIN = 'ffmpeg'

/** ffmpeg can be chatty; only the tail is worth putting in an error message. */
const MAX_FFMPEG_STDERR = 4096

async function openAudioFiles(event: IpcMainInvokeEvent): Promise<string[]> {
  const owner = BrowserWindow.fromWebContents(event.sender)
  const options: Electron.OpenDialogOptions = {
    title: 'Import Tracks',
    buttonLabel: 'Import',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio', extensions: AUDIO_EXTENSIONS },
      { name: 'All Files', extensions: ['*'] }
    ]
  }

  // An owned dialog is a sheet on macOS, not a floating window.
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)

  return result.canceled ? [] : result.filePaths
}

async function readAudioFile(path: string): Promise<ArrayBuffer> {
  // A missing file or a directory would otherwise surface in the renderer as
  // an opaque decode failure much later on.
  const info = await stat(path).catch(() => null)
  if (!info) throw new Error(`No such file: ${path}`)
  if (!info.isFile()) throw new Error(`Not a file: ${path}`)

  return toArrayBuffer(await readFile(path))
}

/**
 * ffmpeg writes WAV to a pipe without knowing the final length, so it leaves
 * the RIFF and data chunk sizes at a placeholder. Chromium refuses such a file.
 * We have the whole thing in memory by then, so patch the real sizes in.
 */
function repairWavSizes(buf: Buffer): Buffer {
  if (buf.byteLength < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf
  buf.writeUInt32LE(buf.byteLength - 8, 4)

  // Walk the chunk list; ffmpeg may emit LIST/fmt chunks before the audio.
  let offset = 12
  while (offset + 8 <= buf.byteLength) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'data') {
      const available = buf.byteLength - body
      if (size === 0 || size > available) buf.writeUInt32LE(available, offset + 4)
      break
    }
    if (size === 0 || size > buf.byteLength - body) break
    offset = body + size + (size % 2) // chunks are word-aligned
  }
  return buf
}

/**
 * Decode `path` to a float WAV.
 *
 * `untrimmed` keeps the encoder's own padding at the front and back of the
 * stream instead of dropping it. A compressed file carries a little silence
 * either end that gapless playback throws away; a beat grid written against
 * the untrimmed stream counts that silence as part of the track, so the audio
 * has to keep it or every position in the file lands early.
 */
function transcodeToWav(path: string, untrimmed = false): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const args = transcodeArgs(path, untrimmed)
    const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    const chunks: Buffer[] = []
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_FFMPEG_STDERR)
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'ENOENT'
          ? new Error(
              `ffmpeg was not found on PATH, so "${path}" cannot be transcoded. ` +
                'Install it (for example `brew install ffmpeg`) and restart DJDaw.'
            )
          : err
      )
    })

    child.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim()
        const why = detail ? `: ${detail}` : ''
        reject(new Error(`ffmpeg failed on "${path}" (exit ${code ?? 'signal'})${why}`))
        return
      }
      const out = Buffer.concat(chunks)
      if (out.byteLength === 0) {
        reject(new Error(`ffmpeg produced no audio for "${path}"`))
        return
      }
      resolve(toArrayBuffer(repairWavSizes(out)))
    })
  })
}

/** The XML open dialog, shared by the one-shot import and by sync. */
function xmlDialogOptions(buttonLabel: string): Electron.OpenDialogOptions {
  return {
    title: 'Choose rekordbox XML',
    buttonLabel,
    message: 'Choose the XML file exported from rekordbox',
    properties: ['openFile'],
    filters: [
      { name: 'rekordbox XML', extensions: ['xml'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  }
}

async function pickXmlFile(
  event: IpcMainInvokeEvent,
  buttonLabel: string
): Promise<string | null> {
  const owner = BrowserWindow.fromWebContents(event.sender)
  const options = xmlDialogOptions(buttonLabel)
  // An owned dialog is a sheet on macOS, not a floating window.
  const picked = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)

  return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]
}

/**
 * Push a mirror refresh to every window.
 *
 * The mirror is process-wide state: every window shows the same collection.
 */
function broadcastSync(result: RekordboxSyncResult): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('rekordbox:sync', result)
  }
}

/** Re-read the remembered export. Resolves empty when there is none. */
function syncRekordbox(): Promise<RekordboxSyncResult> {
  const xmlPath = getRekordboxXmlPath()
  return xmlPath ? syncFromXml(xmlPath) : Promise.resolve(emptyMirror(null))
}

/**
 * Choose the XML export to mirror, remember it, and sync it now.
 *
 * The result replaces the renderer's mirror wholesale, so cancelling re-syncs
 * whatever was already remembered and never resolves empty.
 */
async function chooseRekordboxXml(event: IpcMainInvokeEvent): Promise<RekordboxSyncResult> {
  const xmlPath = await pickXmlFile(event, 'Sync')
  if (!xmlPath) return syncRekordbox()

  await setRekordboxXmlPath(xmlPath)
  startWatching(xmlPath, broadcastSync)
  return syncFromXml(xmlPath)
}

/** Forget the export, stop watching it, and clear the mirror everywhere. */
async function clearRekordboxXml(): Promise<void> {
  stopWatching()
  await setRekordboxXmlPath(null)
  broadcastSync(emptyMirror(null))
}

/**
 * Start mirroring the remembered export, if there is one, and push the result.
 *
 * Called once the first window has loaded, so the mirror is populated at
 * launch. The push can land before the renderer subscribes; a renderer that
 * missed it calls `syncRekordbox`.
 */
export async function startRekordboxSync(): Promise<void> {
  // Read from disk, not from `getRekordboxXmlPath`: at launch nothing has
  // loaded the library into main yet.
  const lib = await loadLibrary()
  const remembered = lib.rekordboxXmlPath

  // An explicit null means the user disconnected; leave it alone. Only an
  // absent value — never configured — falls back to rekordbox's own default
  // export location, so the collection is there on a first run with no setup.
  if (remembered === null) return
  const xmlPath = remembered ?? defaultRekordboxXmlPath()
  if (!xmlPath) return

  // Watch before checking the file exists. rekordbox writes the export when it
  // quits, so on a first run the file legitimately appears later, and the
  // watcher is on the containing directory precisely so it catches that.
  startWatching(xmlPath, async (result) => {
    if (result.tracks.length > 0 && !getRekordboxXmlPath()) await setRekordboxXmlPath(result.xmlPath)
    broadcastSync(result)
  })

  if (!existsSync(xmlPath)) {
    // Not an error: the user may simply not have exported yet. Report the path
    // being watched so the UI can say what it is waiting for.
    broadcastSync(emptyMirror(xmlPath))
    return
  }

  const result = await syncFromXml(xmlPath)
  // Only remember a path once it has actually parsed into something.
  if (!remembered && result.tracks.length > 0) await setRekordboxXmlPath(xmlPath)
  broadcastSync(result)
}

/**
 * Read a rekordbox XML collection export.
 *
 * The XML export is the supported interchange format, and a copy of the live
 * database. Parsed here, so a large collection never crosses IPC as one string.
 */
async function importRekordboxXml(event: IpcMainInvokeEvent): Promise<RekordboxImportResult> {
  const xmlPath = await pickXmlFile(event, 'Import')
  if (!xmlPath) {
    return { xmlPath: null, producedBy: '', tracks: [], missingPaths: [], playlists: [], idMap: {} }
  }

  const text = await readFile(xmlPath, 'utf8')
  const collection = parseRekordboxXml(text)

  const tracks: Track[] = []
  const missingPaths: string[] = []
  const idMap: Record<string, string> = {}

  for (const entry of collection.tracks) {
    if (!entry.path) continue
    const id = trackIdForPath(entry.path)
    idMap[entry.trackId] = id
    // A collection that lives on an external drive will reference files that
    // are not mounted. Those stay in the library, the way rekordbox keeps them,
    // and are reported so the count is never silently short.
    if (!existsSync(entry.path)) missingPaths.push(entry.path)
    tracks.push(trackFromRekordbox(entry, id))
  }

  const playlists = collection.playlists.map((p) => ({
    name: p.name,
    folders: p.folders,
    trackIds: p.trackIds.map((rbId) => idMap[rbId]).filter((v): v is string => Boolean(v))
  }))

  return { xmlPath, producedBy: collection.producedBy, tracks, missingPaths, playlists, idMap }
}

export function registerIpcHandlers(): void {
  ipcMain.handle('audio:openFiles', (event): Promise<string[]> => openAudioFiles(event))

  ipcMain.handle('library:importPaths', (_event, paths: string[]): Promise<Track[]> =>
    importPaths(Array.isArray(paths) ? paths : [])
  )

  ipcMain.handle('audio:readFile', (_event, path: string): Promise<ArrayBuffer> => readAudioFile(path))

  ipcMain.handle(
    'audio:transcodeToWav',
    (_event, path: string, untrimmed?: boolean): Promise<ArrayBuffer> =>
      transcodeToWav(path, untrimmed === true)
  )

  ipcMain.handle('stems:model', (): Promise<ArrayBuffer> => readStemModel())

  ipcMain.handle(
    'stems:write',
    (_event, audioKey: string, stems: Record<string, Float32Array>) =>
      writeStems(audioKey, stems as Record<StemName, Float32Array>)
  )

  ipcMain.handle('stems:cached', (_event, audioKey: string) => cachedStems(audioKey))

  ipcMain.handle('library:load', (): Promise<LibraryFile> => loadLibrary())

  ipcMain.handle('library:save', (_event, lib: LibraryFile): Promise<void> => saveLibrary(lib))

  ipcMain.handle('waveform:read', (_event, audioKey: string): Promise<ArrayBuffer | null> =>
    readWaveformCache(audioKey)
  )

  ipcMain.handle('waveform:write', (_event, audioKey: string, data: ArrayBuffer): Promise<void> =>
    writeWaveformCache(audioKey, data)
  )

  ipcMain.handle('library:importRekordboxXml', (event): Promise<RekordboxImportResult> =>
    importRekordboxXml(event)
  )

  ipcMain.handle('rekordbox:choose', (event): Promise<RekordboxSyncResult> =>
    chooseRekordboxXml(event)
  )

  ipcMain.handle('rekordbox:syncNow', (): Promise<RekordboxSyncResult> => syncRekordbox())

  ipcMain.handle('rekordbox:clear', (): Promise<void> => clearRekordboxXml())

  // Never rejects. A failed export comes back as `error` on the result.
  ipcMain.handle('audio:export', (_event, request: ExportRequest): Promise<ExportResult> =>
    exportAudio(request)
  )

  ipcMain.handle('shell:reveal', (_event, path: string): void => {
    shell.showItemInFolder(path)
  })
}
