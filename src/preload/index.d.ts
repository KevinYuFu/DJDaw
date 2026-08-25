import type {
  ExportRequest,
  ExportResult,
  LibraryFile,
  Track,
  RekordboxImportResult,
  RekordboxSyncResult
} from '../shared/types'

/**
 * Everything the renderer can ask the main process for. Implemented in
 * `preload/index.ts` and exposed as `window.api`.
 *
 * The relative import above is deliberate: this file is pulled into the
 * renderer's program (tsconfig.web.json includes `src/preload/*.d.ts`) as well
 * as the node one, and only a relative path resolves in both.
 */
export interface DJDawApi {
  /** Native open dialog filtered to audio files. Returns absolute paths. */
  openAudioFiles(): Promise<string[]>
  /** Read tags + duration for paths, returning fully-formed Track records. */
  importPaths(paths: string[]): Promise<Track[]>
  /**
   * Open a rekordbox XML export and convert the whole collection, including
   * beat grids and hot cues. Resolves with an empty result if cancelled.
   */
  importRekordboxXml(): Promise<RekordboxImportResult>
  /**
   * Absolute path of a File from a drag and drop. Electron removed
   * `File.path`, and its replacement lives only in the preload realm.
   * Returns an empty string for a file that has no path on disk.
   */
  getPathForFile(file: File): string
  /**
   * Pick the rekordbox XML export to mirror, remember it for next launch, and
   * sync it immediately. Cancelling leaves the current mirror as it was.
   */
  chooseRekordboxXml(): Promise<RekordboxSyncResult>
  /**
   * Re-read the remembered export now. Empty when none has been chosen; an
   * export that has moved or gone comes back with `error` set, never a throw.
   */
  syncRekordbox(): Promise<RekordboxSyncResult>
  /** Forget the remembered export, stop watching it, and clear the mirror. */
  clearRekordboxXml(): Promise<void>
  /** Raw bytes for decodeAudioData. */
  readAudioFile(path: string): Promise<ArrayBuffer>
  /** ffmpeg fallback -> 32-bit float WAV bytes, for formats Chromium rejects. */
  transcodeToWav(path: string): Promise<ArrayBuffer>
  loadLibrary(): Promise<LibraryFile>
  saveLibrary(lib: LibraryFile): Promise<void>
  /**
   * The waveform cache is keyed on `Track.audioKey`, not on the track id, so a
   * local fork reuses the analysis of the file it was forked from.
   */
  readWaveformCache(audioKey: string): Promise<ArrayBuffer | null>
  writeWaveformCache(audioKey: string, data: ArrayBuffer): Promise<void>
  /**
   * Write a finished render into `~/Music/DJDaw`, creating the folder if it is
   * not there, and return the file it wrote. An existing name is never
   * overwritten: a numeric suffix is added instead, so the returned path is the
   * only reliable answer to where the export went.
   *
   * This never rejects for a failure the user can act on — no ffmpeg for MP3,
   * a full disk — those come back with `path` null and `error` set to a line
   * that can be shown as it is.
   */
  exportAudio(request: ExportRequest): Promise<ExportResult>
  /**
   * Show a file in Finder. Feed it the `path` from {@link exportAudio} to offer
   * "reveal" after an export. A null path or a file that has gone does nothing,
   * and never throws.
   */
  revealInFinder(path: string): Promise<void>
  /** Menu commands from the app menu. Returns an unsubscribe fn. */
  onMenuCommand(cb: (command: string) => void): () => void
  /**
   * A rebuilt rekordbox mirror, pushed at launch and whenever the watched XML
   * export is rewritten. The result replaces the mirror wholesale — it is not
   * a delta. Returns an unsubscribe fn.
   */
  onRekordboxSync(cb: (result: RekordboxSyncResult) => void): () => void
}

declare global {
  interface Window {
    api: DJDawApi
  }
}
