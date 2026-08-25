/**
 * Shared domain types. Imported by the Electron main process, the preload
 * bridge and the renderer, so this file must stay free of runtime deps.
 */

/**
 * Every deck, in the order the views lay them out. The single ordered list:
 * anything that builds one value per deck, or walks them, iterates this rather
 * than writing the ids out again. The performance view uses the first two;
 * the editing view stacks all four.
 */
export const DECK_IDS = ['A', 'B', 'C', 'D'] as const

export type DeckId = (typeof DECK_IDS)[number]

/**
 * Which collection a record belongs to.
 *
 * `rekordbox` records are a read-only mirror of the last XML export: they are
 * never persisted and are replaced wholesale on every sync, so the mirror is
 * always exactly what rekordbox said. Editing one forks it to a `local` record,
 * which is what gets saved.
 */
export type TrackSource = 'local' | 'rekordbox'

/** A tempo anchor. The tempo applies from `time` until the next anchor. */
export interface BeatGridAnchor {
  /** Seconds from the start of the file. */
  time: number
  /** Tempo, in beats per minute, in effect from this anchor onward. */
  bpm: number
}

/**
 * rekordbox-style beat grid. `anchors[0].time` is the first downbeat, and
 * defines beat index 0; beat indices before it are negative. A grid with a
 * single anchor is a constant-tempo grid, which is the common case.
 */
export interface BeatGrid {
  anchors: BeatGridAnchor[]
  /** Beats per bar. 4 for practically all dance music. */
  beatsPerBar: number
}

export type HotCueType = 'cue' | 'loop'

export interface HotCue {
  /** 0-7, rendered as pads A-H. */
  index: number
  /** Seconds from the start of the file. */
  time: number
  name?: string
  /** Hex colour, e.g. '#00b04f'. */
  color: string
  type: HotCueType
  /** Loop length in beats, when `type` is 'loop'. */
  loopBeats?: number
}

export interface MemoryCue {
  time: number
  name?: string
}

/** Everything the library knows about one file. Waveform data lives elsewhere. */
export interface Track {
  id: string
  /** Which collection this belongs to. See {@link TrackSource}. */
  source: TrackSource
  /**
   * sha1 of the resolved audio path. A rekordbox record and any local fork of it
   * share this, so a fork inherits the waveform cache.
   */
  audioKey: string
  /** For a local fork, the id of the rekordbox record it came from. */
  forkedFrom?: string
  path: string
  title: string
  artist: string
  album: string
  genre: string
  comment: string
  durationSec: number
  sampleRate: number
  channels: number
  /** Tempo shown in the browser. Mirrors `grid.anchors[0].bpm` once analysed. */
  bpm: number | null
  /** Camelot / classic key notation, e.g. '8A' or 'Am'. Null until detected. */
  key: string | null
  grid: BeatGrid | null
  hotCues: HotCue[]
  memoryCues: MemoryCue[]
  /** The CUE point, CDJ-style. Null means "start of track". */
  cuePoint: number | null
  rating: number
  color: string | null
  dateAdded: number
  /** True once waveform + tempo analysis has been written to the cache. */
  analyzed: boolean
  /** data: URL of embedded artwork, small enough to keep in the library JSON. */
  artwork: string | null
}

/** Header written alongside the binary waveform cache. */
export interface WaveformMeta {
  version: number
  /** Audio frames summarised by one waveform bucket. */
  bucketSize: number
  sampleRate: number
  bucketCount: number
  /** Absolute sample peak of the whole file, for gain display. */
  peak: number
}

/**
 * Three-band waveform summary, rekordbox's blue/orange/white rendering.
 * Each array holds one unsigned byte per bucket: the band's peak amplitude
 * scaled to 0-255.
 */
export interface WaveformData extends WaveformMeta {
  low: Uint8Array
  mid: Uint8Array
  high: Uint8Array
}

export interface AnalysisResult {
  waveform: WaveformData
  grid: BeatGrid
  bpm: number
  /** 0-1 confidence in the detected tempo. */
  confidence: number
}

export interface LibraryFile {
  version: number
  /** Local records only. The rekordbox mirror is derived, never stored. */
  tracks: Track[]
  /**
   * Remembered rekordbox XML export, watched for changes. Three states:
   * a path to use, `null` when the user explicitly disconnected, and absent
   * when it has never been configured — only the last of those lets the app
   * adopt rekordbox's default export location by itself.
   */
  rekordboxXmlPath?: string | null
}

/** A rekordbox mirror refresh, pushed by main whenever the XML changes. */
export interface RekordboxSyncResult {
  xmlPath: string | null
  producedBy: string
  tracks: Track[]
  missingPaths: string[]
  playlists: RekordboxPlaylistRef[]
  /** When the XML was last written, for the "synced from" readout. */
  syncedAt: number
  /** Set when a sync was attempted and failed, e.g. the file is gone. */
  error?: string
}

/** Outcome of reading a rekordbox XML collection export. */
export interface RekordboxImportResult {
  /** Absolute path of the XML that was read, or null if the user cancelled. */
  xmlPath: string | null
  /** The rekordbox version that produced the file, when it says. */
  producedBy: string
  /** Fully-formed tracks, ids already hashed from their paths. */
  tracks: Track[]
  /** Paths referenced by the XML that are not on this machine right now. */
  missingPaths: string[]
  playlists: RekordboxPlaylistRef[]
  /** rekordbox TrackID to DJDaw track id, so playlists can be resolved later. */
  idMap: Record<string, string>
}

export interface RekordboxPlaylistRef {
  name: string
  /** Enclosing folder names, outermost first. */
  folders: string[]
  /** DJDaw track ids, in playlist order. */
  trackIds: string[]
}

export interface ImportedFile {
  track: Track
  /** Raw bytes of the audio file, for `decodeAudioData` in the renderer. */
  data?: ArrayBuffer
}

/** What an export is written as. WAV is the render itself; MP3 is encoded from it. */
export type ExportFormat = 'wav' | 'mp3'

/** A finished render on its way to a file. */
export interface ExportRequest {
  /**
   * The render, as WAV bytes. Always WAV, whatever `format` says: that is what
   * an OfflineAudioContext render turns into directly, and every other format
   * is an encode on top of it, done in main where ffmpeg lives.
   */
  wav: ArrayBuffer
  format: ExportFormat
  /** Wanted file name, without an extension. Main sanitises it before use. */
  name: string
}

/** Where an export landed, or why it did not. */
export interface ExportResult {
  /** Absolute path of the file written, or null when nothing was. */
  path: string | null
  /** Set when the export failed. Plain text, ready to show the user. */
  error?: string
}
