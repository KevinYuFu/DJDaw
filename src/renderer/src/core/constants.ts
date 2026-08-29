/** Beat-jump sizes offered by the selector, matching rekordbox's list. */
export const BEAT_JUMP_SIZES = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64] as const

/** Q / W jump this far by default, as the user asked for. */
export const DEFAULT_BEAT_JUMP = 16

/** Auto-loop sizes, in beats. */
export const LOOP_SIZES = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32] as const

/** Tempo fader ranges, in percent, as on a CDJ. */
export const TEMPO_RANGES = [6, 10, 16, 100] as const

/** rekordbox's default hot cue pad colours, A through H. */
export const HOT_CUE_COLORS = [
  '#00a0e9', // A - blue
  '#7ac943', // B - green
  '#fff100', // C - yellow
  '#f5a11c', // D - orange
  '#ea5532', // E - red
  '#e4007f', // F - magenta
  '#8f57a0', // G - purple
  '#00a99d'  // H - teal
] as const

export const HOT_CUE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const
export const HOT_CUE_COUNT = 8

/** Detailed-waveform zoom levels, in seconds of audio across the full width. */
export const WAVE_ZOOM_LEVELS = [1.5, 2.5, 4, 6, 9, 14, 22, 34] as const
export const DEFAULT_ZOOM_INDEX = 3

/** Samples of audio summarised by one waveform bucket. */
export const WAVEFORM_BUCKET = 128
export const WAVEFORM_CACHE_VERSION = 2
export const LIBRARY_VERSION = 1

/** Waveform band colours. rekordbox's classic "3Band" look. */
export const CUE_COLOR = '#e8433a'
export const LOOP_COLOR = '#f5a11c'
export const GRID_BEAT_COLOR = 'rgba(255,255,255,0.28)'
export const GRID_DOWNBEAT_COLOR = 'rgba(255,255,255,0.85)'
