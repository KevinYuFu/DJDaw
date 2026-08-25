/**
 * Colour themes.
 *
 * Every colour the app draws comes from one of these token sets, applied to the
 * document root. The Settings picker previews a theme from the same records, so
 * a swatch is the colour that will actually be used.
 *
 * Backgrounds run darkest to lightest; `--bg-waveform` stays the darkest
 * surface in every theme, since a waveform needs the contrast whatever the rest
 * of the chrome is doing.
 */

export interface Theme {
  id: string
  name: string
  /** One line for the picker. */
  note: string
  tokens: Record<string, string>
}

export const THEME_STORAGE_KEY = 'djdaw.theme'

/** The tokens a theme sets. Anything else is a metric and does not change. */
export interface ThemeTokens {
  'bg-app': string
  'bg-panel': string
  'bg-panel-2': string
  'bg-raised': string
  'bg-raised-hover': string
  'bg-pressed': string
  'bg-sunken': string
  'bg-waveform': string
  border: string
  'border-soft': string
  'border-strong': string
  text: string
  'text-dim': string
  'text-faint': string
  'text-inverse': string
  accent: string
  'accent-dim': string
  'accent-glow': string
  'deck-a': string
  'deck-b': string
  'deck-c': string
  'deck-d': string
  play: string
  'play-glow': string
  cue: string
  'cue-glow': string
  danger: string
  loop: string
  'wave-low': string
  'wave-mid': string
  'wave-high': string
  /** Top and bottom of the moulded chrome on knobs, caps and jog wheels. */
  'chrome-hi': string
  'chrome-lo': string
  /** Wash over a surface, for hover and selection. */
  overlay: string
  'overlay-strong': string
  /** Scrollbar thumb. */
  thumb: string
  'thumb-hover': string
  /** The line that follows playback, drawn on canvas. */
  playhead: string
  /** Grid lines on an arrangement lane, faintest first. */
  'grid-beat': string
  'grid-bar': string
  'grid-phrase': string
  /** A clip's body and its title strip, at rest and picked. */
  'clip-body': string
  'clip-body-on': string
  'clip-head': string
  'clip-head-on': string
  'clip-edge': string
  'clip-edge-on': string
  /** Text on a clip's title strip. */
  'clip-text': string
}

function theme(id: string, name: string, note: string, tokens: ThemeTokens): Theme {
  return { id, name, note, tokens: tokens as unknown as Record<string, string> }
}

export const THEMES: readonly Theme[] = [
  theme('booth', 'Booth', 'Neutral charcoal and cyan. The darkest of the set.', {
    'bg-app': '#0d0e11',
    'bg-panel': '#16181c',
    'bg-panel-2': '#1c1f24',
    'bg-raised': '#272b32',
    'bg-raised-hover': '#333841',
    'bg-pressed': '#1a1d22',
    'bg-sunken': '#0f1114',
    'bg-waveform': '#06070a',
    border: '#4a515d',
    'border-soft': '#2f343d',
    'border-strong': '#6b7482',
    text: '#e9ecf1',
    'text-dim': '#b7bec9',
    'text-faint': '#98a0ad',
    'text-inverse': '#0b0c0f',
    accent: '#28a9f0',
    'accent-dim': '#155f8c',
    'accent-glow': 'rgba(40, 169, 240, 0.35)',
    'deck-a': '#28a9f0',
    'deck-b': '#f5a11c',
    'deck-c': '#3ed48a',
    'deck-d': '#f5636f',
    play: '#37c95a',
    'play-glow': 'rgba(55, 201, 90, 0.45)',
    cue: '#f5a11c',
    'cue-glow': 'rgba(245, 161, 28, 0.4)',
    danger: '#ec4a3f',
    loop: '#f5a11c',
    'wave-low': '#2170e6',
    'wave-mid': '#f0921f',
    'wave-high': '#eaf3ff',
    'chrome-hi': '#454b57',
    'chrome-lo': '#20242a',
    overlay: 'rgba(255, 255, 255, 0.055)',
    'overlay-strong': 'rgba(255, 255, 255, 0.1)',
    thumb: '#3a3f49',
    'thumb-hover': '#4d5460',
    playhead: '#ffffff',
    'grid-beat': 'rgba(214, 228, 250, 0.10)',
    'grid-bar': 'rgba(214, 228, 250, 0.26)',
    'grid-phrase': 'rgba(220, 233, 255, 0.42)',
    'clip-body': 'rgba(58, 74, 100, 0.22)',
    'clip-body-on': 'rgba(90, 122, 168, 0.30)',
    'clip-head': 'rgba(90, 110, 145, 0.40)',
    'clip-head-on': 'rgba(120, 156, 210, 0.55)',
    'clip-edge': 'rgba(150, 170, 200, 0.45)',
    'clip-edge-on': 'rgba(160, 195, 255, 0.95)',
    'clip-text': 'rgba(255, 255, 255, 0.86)'
  }),

  theme('midnight', 'Midnight', 'Deep indigo with a violet accent. Soft on the eyes.', {
    'bg-app': '#0a0c16',
    'bg-panel': '#13172a',
    'bg-panel-2': '#191e35',
    'bg-raised': '#242b49',
    'bg-raised-hover': '#2f375b',
    'bg-pressed': '#161b31',
    'bg-sunken': '#070911',
    'bg-waveform': '#05060f',
    border: '#46507e',
    'border-soft': '#2a3152',
    'border-strong': '#6470a6',
    text: '#e8ebf9',
    'text-dim': '#b4bbd8',
    'text-faint': '#9199bd',
    'text-inverse': '#080a12',
    accent: '#8b7cff',
    'accent-dim': '#4c3fae',
    'accent-glow': 'rgba(139, 124, 255, 0.4)',
    'deck-a': '#7b93ff',
    'deck-b': '#f2a13c',
    'deck-c': '#4fd8b6',
    'deck-d': '#ff6b9d',
    play: '#40d494',
    'play-glow': 'rgba(64, 212, 148, 0.45)',
    cue: '#f2a13c',
    'cue-glow': 'rgba(242, 161, 60, 0.4)',
    danger: '#f2596b',
    loop: '#f2a13c',
    'wave-low': '#4c63e8',
    'wave-mid': '#e8913a',
    'wave-high': '#eef2ff',
    'chrome-hi': '#3f4870',
    'chrome-lo': '#171c32',
    overlay: 'rgba(190, 200, 255, 0.07)',
    'overlay-strong': 'rgba(190, 200, 255, 0.13)',
    thumb: '#333b60',
    'thumb-hover': '#454f7c',
    playhead: '#ffffff',
    'grid-beat': 'rgba(198, 205, 255, 0.11)',
    'grid-bar': 'rgba(198, 205, 255, 0.28)',
    'grid-phrase': 'rgba(210, 216, 255, 0.46)',
    'clip-body': 'rgba(70, 82, 140, 0.26)',
    'clip-body-on': 'rgba(108, 116, 210, 0.34)',
    'clip-head': 'rgba(104, 114, 178, 0.44)',
    'clip-head-on': 'rgba(146, 148, 240, 0.58)',
    'clip-edge': 'rgba(160, 170, 220, 0.45)',
    'clip-edge-on': 'rgba(180, 176, 255, 0.95)',
    'clip-text': 'rgba(255, 255, 255, 0.88)'
  }),

  theme('amber', 'Amber', 'Warm and low-glare, the way a valve amp looks.', {
    'bg-app': '#12100c',
    'bg-panel': '#1c1914',
    'bg-panel-2': '#232019',
    'bg-raised': '#302c22',
    'bg-raised-hover': '#3d382c',
    'bg-pressed': '#1e1b15',
    'bg-sunken': '#100e0a',
    'bg-waveform': '#0a0806',
    border: '#5a5243',
    'border-soft': '#3a352b',
    'border-strong': '#7d7259',
    text: '#f2ece1',
    'text-dim': '#c9beaa',
    'text-faint': '#a79c88',
    'text-inverse': '#12100c',
    accent: '#f0a63a',
    'accent-dim': '#9c6712',
    'accent-glow': 'rgba(240, 166, 58, 0.38)',
    'deck-a': '#f0a63a',
    'deck-b': '#5ec2e8',
    'deck-c': '#9ad356',
    'deck-d': '#f0685f',
    play: '#8bcf46',
    'play-glow': 'rgba(139, 207, 70, 0.42)',
    cue: '#f0a63a',
    'cue-glow': 'rgba(240, 166, 58, 0.4)',
    danger: '#e8574e',
    loop: '#f0a63a',
    'wave-low': '#3f83d6',
    'wave-mid': '#eda43c',
    'wave-high': '#fff3e2',
    'chrome-hi': '#544c3c',
    'chrome-lo': '#241f18',
    overlay: 'rgba(255, 236, 200, 0.06)',
    'overlay-strong': 'rgba(255, 236, 200, 0.11)',
    thumb: '#453e31',
    'thumb-hover': '#5b5243',
    playhead: '#fff8ec',
    'grid-beat': 'rgba(255, 236, 205, 0.10)',
    'grid-bar': 'rgba(255, 236, 205, 0.26)',
    'grid-phrase': 'rgba(255, 240, 214, 0.44)',
    'clip-body': 'rgba(110, 88, 56, 0.26)',
    'clip-body-on': 'rgba(160, 124, 66, 0.32)',
    'clip-head': 'rgba(140, 116, 74, 0.44)',
    'clip-head-on': 'rgba(198, 154, 78, 0.58)',
    'clip-edge': 'rgba(198, 180, 146, 0.45)',
    'clip-edge-on': 'rgba(245, 200, 130, 0.95)',
    'clip-text': 'rgba(255, 248, 236, 0.9)'
  }),

  theme('slate', 'Slate', 'Lighter blue-grey and teal, for a long session.', {
    'bg-app': '#191d22',
    'bg-panel': '#232830',
    'bg-panel-2': '#2a3039',
    'bg-raised': '#363d48',
    'bg-raised-hover': '#434c58',
    'bg-pressed': '#252a32',
    'bg-sunken': '#14181c',
    'bg-waveform': '#0e1115',
    border: '#59626f',
    'border-soft': '#3c4450',
    'border-strong': '#7b8593',
    text: '#f0f3f7',
    'text-dim': '#c2cad4',
    'text-faint': '#9ea7b3',
    'text-inverse': '#12161a',
    accent: '#2bc0ad',
    'accent-dim': '#177a6e',
    'accent-glow': 'rgba(43, 192, 173, 0.38)',
    'deck-a': '#3fbdf0',
    'deck-b': '#f0a63c',
    'deck-c': '#5ad99b',
    'deck-d': '#f4707d',
    play: '#46cf7d',
    'play-glow': 'rgba(70, 207, 125, 0.42)',
    cue: '#f0a63c',
    'cue-glow': 'rgba(240, 166, 60, 0.4)',
    danger: '#ef5f57',
    loop: '#f0a63c',
    'wave-low': '#3a86e0',
    'wave-mid': '#eda23f',
    'wave-high': '#f2f7ff',
    'chrome-hi': '#59626f',
    'chrome-lo': '#2b313a',
    overlay: 'rgba(255, 255, 255, 0.06)',
    'overlay-strong': 'rgba(255, 255, 255, 0.11)',
    thumb: '#49515d',
    'thumb-hover': '#5d6673',
    playhead: '#ffffff',
    'grid-beat': 'rgba(220, 232, 245, 0.11)',
    'grid-bar': 'rgba(220, 232, 245, 0.28)',
    'grid-phrase': 'rgba(228, 238, 250, 0.44)',
    'clip-body': 'rgba(78, 100, 124, 0.28)',
    'clip-body-on': 'rgba(60, 150, 142, 0.32)',
    'clip-head': 'rgba(108, 130, 152, 0.44)',
    'clip-head-on': 'rgba(70, 178, 166, 0.56)',
    'clip-edge': 'rgba(160, 178, 196, 0.45)',
    'clip-edge-on': 'rgba(110, 216, 202, 0.95)',
    'clip-text': 'rgba(255, 255, 255, 0.88)'
  }),

  theme('paper', 'Paper', 'Warm off-white and a deep sea-blue. Light, never glaring.', {
    'bg-app': '#e9e5dc',
    'bg-panel': '#f3f0e9',
    'bg-panel-2': '#eae6dd',
    'bg-raised': '#dedacf',
    'bg-raised-hover': '#d2cdc0',
    'bg-pressed': '#c9c3b4',
    'bg-sunken': '#dcd7cb',
    'bg-waveform': '#20242c',
    border: '#a8a294',
    'border-soft': '#c8c2b4',
    'border-strong': '#7d7768',
    text: '#232019',
    'text-dim': '#4e4a40',
    'text-faint': '#66614f',
    'text-inverse': '#f7f5f0',
    accent: '#15607f',
    'accent-dim': '#0e4358',
    'accent-glow': 'rgba(21, 96, 127, 0.28)',
    'deck-a': '#15607f',
    'deck-b': '#9a5510',
    'deck-c': '#1f7346',
    'deck-d': '#a5322f',
    play: '#1f7346',
    'play-glow': 'rgba(31, 115, 70, 0.3)',
    cue: '#9a5510',
    'cue-glow': 'rgba(154, 85, 16, 0.3)',
    danger: '#a5322f',
    loop: '#9a5510',
    'wave-low': '#4a9eff',
    'wave-mid': '#ffab3d',
    'wave-high': '#f4f8ff',
    'chrome-hi': '#f0ece3',
    'chrome-lo': '#cbc5b7',
    overlay: 'rgba(35, 32, 25, 0.06)',
    'overlay-strong': 'rgba(35, 32, 25, 0.12)',
    thumb: '#bab4a5',
    'thumb-hover': '#9e9788',
    playhead: '#1a1712',
    'grid-beat': 'rgba(40, 36, 28, 0.10)',
    'grid-bar': 'rgba(40, 36, 28, 0.24)',
    'grid-phrase': 'rgba(30, 27, 20, 0.42)',
    'clip-body': 'rgba(21, 96, 127, 0.13)',
    'clip-body-on': 'rgba(21, 96, 127, 0.22)',
    'clip-head': 'rgba(21, 96, 127, 0.38)',
    'clip-head-on': 'rgba(21, 96, 127, 0.62)',
    'clip-edge': 'rgba(70, 84, 96, 0.45)',
    'clip-edge-on': 'rgba(14, 67, 88, 0.95)',
    'clip-text': 'rgba(255, 255, 255, 0.95)'
  }),

  theme('blossom', 'Blossom', 'Soft pink with a plum accent. Light and warm.', {
    'bg-app': '#f6e6ec',
    'bg-panel': '#fdf1f5',
    'bg-panel-2': '#f7e8ef',
    'bg-raised': '#efd9e2',
    'bg-raised-hover': '#e7ccd8',
    'bg-pressed': '#dcbcca',
    'bg-sunken': '#eedbe4',
    'bg-waveform': '#2a1f27',
    border: '#c9a3b3',
    'border-soft': '#e0c2ce',
    'border-strong': '#96697c',
    text: '#2c1a24',
    'text-dim': '#5a3c49',
    'text-faint': '#75525f',
    'text-inverse': '#fdf4f7',
    accent: '#a52f6e',
    'accent-dim': '#75204e',
    'accent-glow': 'rgba(165, 47, 110, 0.3)',
    'deck-a': '#a52f6e',
    'deck-b': '#0f6d84',
    'deck-c': '#2c7a45',
    'deck-d': '#b03636',
    play: '#2c7a45',
    'play-glow': 'rgba(44, 122, 69, 0.3)',
    cue: '#a4560f',
    'cue-glow': 'rgba(164, 86, 15, 0.3)',
    danger: '#b03636',
    loop: '#a4560f',
    'wave-low': '#ff7ab8',
    'wave-mid': '#ffc46b',
    'wave-high': '#fff2f7',
    'chrome-hi': '#fbeaf0',
    'chrome-lo': '#dfc0ce',
    overlay: 'rgba(60, 26, 42, 0.06)',
    'overlay-strong': 'rgba(60, 26, 42, 0.12)',
    thumb: '#d6adbe',
    'thumb-hover': '#b98ba0',
    playhead: '#2c1a24',
    'grid-beat': 'rgba(60, 26, 42, 0.10)',
    'grid-bar': 'rgba(60, 26, 42, 0.24)',
    'grid-phrase': 'rgba(52, 20, 36, 0.42)',
    'clip-body': 'rgba(165, 47, 110, 0.13)',
    'clip-body-on': 'rgba(165, 47, 110, 0.22)',
    'clip-head': 'rgba(165, 47, 110, 0.4)',
    'clip-head-on': 'rgba(165, 47, 110, 0.66)',
    'clip-edge': 'rgba(140, 96, 116, 0.45)',
    'clip-edge-on': 'rgba(117, 32, 78, 0.95)',
    'clip-text': 'rgba(255, 255, 255, 0.95)'
  })
]

export const DEFAULT_THEME_ID = THEMES[0].id

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

/** Write a theme's tokens onto the document root. */
export function applyTheme(id: string): void {
  const { tokens } = themeById(id)
  const root = document.documentElement
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(`--${name}`, value)
  }
  root.dataset.theme = id
}

export interface BandColors {
  low: string
  mid: string
  high: string
}

/** Mix a colour towards black by `amount`, 0 unchanged to 1 black. */
function darken(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const mix = (c: number): number => Math.round(c * (1 - amount))
  const [r, g, b] = [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)]
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

/** The three waveform bands a theme draws with. */
export function bandColors(id: string): BandColors {
  const t = themeById(id).tokens
  return { low: t['wave-low'], mid: t['wave-mid'], high: t['wave-high'] }
}

/** The same bands for the part of an overview already played. */
export function bandColorsDim(id: string): BandColors {
  const bands = bandColors(id)
  return {
    low: darken(bands.low, 0.55),
    mid: darken(bands.mid, 0.5),
    high: darken(bands.high, 0.45)
  }
}

export interface CanvasChrome {
  playhead: string
  gridBeat: string
  gridBar: string
  gridPhrase: string
  clipBody: string
  clipBodyOn: string
  clipHead: string
  clipHeadOn: string
  clipEdge: string
  clipEdgeOn: string
  clipText: string
}

/** The colours a canvas draws chrome with, which cannot read a CSS variable. */
export function canvasChrome(id: string): CanvasChrome {
  const t = themeById(id).tokens
  return {
    playhead: t.playhead,
    gridBeat: t['grid-beat'],
    gridBar: t['grid-bar'],
    gridPhrase: t['grid-phrase'],
    clipBody: t['clip-body'],
    clipBodyOn: t['clip-body-on'],
    clipHead: t['clip-head'],
    clipHeadOn: t['clip-head-on'],
    clipEdge: t['clip-edge'],
    clipEdgeOn: t['clip-edge-on'],
    clipText: t['clip-text']
  }
}
