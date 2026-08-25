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
  theme('booth', 'Booth', 'Neutral charcoal and a cold cyan. The darkest of the set.', {
    'bg-app': '#0e1016',
    'bg-panel': '#191c22',
    'bg-panel-2': '#23262c',
    'bg-raised': '#2f3239',
    'bg-raised-hover': '#3c3f46',
    'bg-pressed': '#13161c',
    'bg-sunken': '#080a0f',
    'bg-waveform': '#040509',
    border: '#4f535b',
    'border-soft': '#2f3238',
    'border-strong': '#767a83',
    text: '#f1f3f9',
    'text-dim': '#ced3dc',
    'text-faint': '#b2b7c1',
    'text-inverse': '#010203',
    accent: '#6fcbfe',
    'accent-dim': '#045a7e',
    'accent-glow': 'rgba(111, 203, 254, 0.45)',
    'deck-a': '#6fcbfe',
    'deck-b': '#feab38',
    'deck-c': '#08e384',
    'deck-d': '#ffa39b',
    play: '#0ce46c',
    'play-glow': 'rgba(12, 228, 108, 0.45)',
    cue: '#feab38',
    'cue-glow': 'rgba(254, 171, 56, 0.45)',
    danger: '#ffa39b',
    loop: '#feab38',
    'wave-low': '#6e9aff',
    'wave-mid': '#faa106',
    'wave-high': '#ecf5fe',
    'chrome-hi': '#44484e',
    'chrome-lo': '#1b1e24',
    overlay: 'rgba(246, 248, 254, 0.07)',
    'overlay-strong': 'rgba(246, 248, 254, 0.13)',
    thumb: '#3f4249',
    'thumb-hover': '#575b62',
    playhead: '#fafcff',
    'grid-beat': 'rgba(232, 239, 252, 0.12)',
    'grid-bar': 'rgba(232, 239, 252, 0.3)',
    'grid-phrase': 'rgba(240, 245, 255, 0.5)',
    'clip-body': 'rgba(111, 203, 254, 0.2)',
    'clip-body-on': 'rgba(111, 203, 254, 0.32)',
    'clip-head': 'rgba(111, 203, 254, 0.5)',
    'clip-head-on': 'rgba(111, 203, 254, 0.78)',
    'clip-edge': 'rgba(168, 174, 187, 0.45)',
    'clip-edge-on': 'rgba(111, 203, 254, 0.95)',
    'clip-text': 'rgba(11, 13, 18, 0.95)'
  }),

  theme('midnight', 'Midnight', 'Deep indigo with a violet accent. Soft on the eyes.', {
    'bg-app': '#0d1018',
    'bg-panel': '#181c23',
    'bg-panel-2': '#22262e',
    'bg-raised': '#2e323b',
    'bg-raised-hover': '#3b3f48',
    'bg-pressed': '#12161d',
    'bg-sunken': '#070a11',
    'bg-waveform': '#03050a',
    border: '#4d535d',
    'border-soft': '#2e323a',
    'border-strong': '#757a86',
    text: '#f1f3f9',
    'text-dim': '#ced3dc',
    'text-faint': '#b2b7c1',
    'text-inverse': '#010203',
    accent: '#d9a7ff',
    'accent-dim': '#7701aa',
    'accent-glow': 'rgba(217, 167, 255, 0.45)',
    'deck-a': '#94c3fe',
    'deck-b': '#feab38',
    'deck-c': '#0ce0a4',
    'deck-d': '#ff9bcb',
    play: '#08e384',
    'play-glow': 'rgba(8, 227, 132, 0.45)',
    cue: '#feab38',
    'cue-glow': 'rgba(254, 171, 56, 0.45)',
    danger: '#ffa1a8',
    loop: '#feab38',
    'wave-low': '#8394fe',
    'wave-mid': '#fe9e24',
    'wave-high': '#f2f2fe',
    'chrome-hi': '#434851',
    'chrome-lo': '#1a1e26',
    overlay: 'rgba(246, 248, 254, 0.07)',
    'overlay-strong': 'rgba(246, 248, 254, 0.13)',
    thumb: '#3e424b',
    'thumb-hover': '#565b64',
    playhead: '#fafcff',
    'grid-beat': 'rgba(232, 239, 252, 0.12)',
    'grid-bar': 'rgba(232, 239, 252, 0.3)',
    'grid-phrase': 'rgba(240, 245, 255, 0.5)',
    'clip-body': 'rgba(217, 167, 255, 0.2)',
    'clip-body-on': 'rgba(217, 167, 255, 0.32)',
    'clip-head': 'rgba(217, 167, 255, 0.5)',
    'clip-head-on': 'rgba(217, 167, 255, 0.78)',
    'clip-edge': 'rgba(168, 174, 187, 0.45)',
    'clip-edge-on': 'rgba(217, 167, 255, 0.95)',
    'clip-text': 'rgba(11, 13, 18, 0.95)'
  }),

  theme('amber', 'Amber', 'Warm and low-glare, the way a valve amp looks.', {
    'bg-app': '#14100a',
    'bg-panel': '#201b15',
    'bg-panel-2': '#2a251e',
    'bg-raised': '#37312b',
    'bg-raised-hover': '#443e37',
    'bg-pressed': '#1a150f',
    'bg-sunken': '#0e0905',
    'bg-waveform': '#070502',
    border: '#585148',
    'border-soft': '#36312a',
    'border-strong': '#807970',
    text: '#f7f3ee',
    'text-dim': '#d8d1c9',
    'text-faint': '#bdb5ac',
    'text-inverse': '#020201',
    accent: '#feab38',
    'accent-dim': '#744700',
    'accent-glow': 'rgba(254, 171, 56, 0.45)',
    'deck-a': '#feab38',
    'deck-b': '#48d1ff',
    'deck-c': '#76de06',
    'deck-d': '#ffa39b',
    play: '#49e406',
    'play-glow': 'rgba(73, 228, 6, 0.45)',
    cue: '#feab38',
    'cue-glow': 'rgba(254, 171, 56, 0.45)',
    danger: '#ffa39b',
    loop: '#feab38',
    'wave-low': '#41a3fe',
    'wave-mid': '#faa106',
    'wave-high': '#fef2dd',
    'chrome-hi': '#4c473f',
    'chrome-lo': '#221d17',
    overlay: 'rgba(255, 247, 237, 0.07)',
    'overlay-strong': 'rgba(255, 247, 237, 0.13)',
    thumb: '#47413a',
    'thumb-hover': '#605a52',
    playhead: '#fffbf6',
    'grid-beat': 'rgba(247, 237, 224, 0.12)',
    'grid-bar': 'rgba(247, 237, 224, 0.3)',
    'grid-phrase': 'rgba(253, 244, 231, 0.5)',
    'clip-body': 'rgba(254, 171, 56, 0.2)',
    'clip-body-on': 'rgba(254, 171, 56, 0.32)',
    'clip-head': 'rgba(254, 171, 56, 0.5)',
    'clip-head-on': 'rgba(254, 171, 56, 0.78)',
    'clip-edge': 'rgba(182, 172, 160, 0.45)',
    'clip-edge-on': 'rgba(254, 171, 56, 0.95)',
    'clip-text': 'rgba(16, 13, 9, 0.95)'
  }),

  theme('slate', 'Slate', 'Cool blue-grey with a teal accent, for a long session.', {
    'bg-app': '#0c1116',
    'bg-panel': '#171c22',
    'bg-panel-2': '#21272d',
    'bg-raised': '#2d3339',
    'bg-raised-hover': '#3a4046',
    'bg-pressed': '#11171c',
    'bg-sunken': '#060b10',
    'bg-waveform': '#030509',
    border: '#4c535c',
    'border-soft': '#2c3239',
    'border-strong': '#737b84',
    text: '#f0f4f9',
    'text-dim': '#ccd4dc',
    'text-faint': '#afb8c1',
    'text-inverse': '#010203',
    accent: '#00dccb',
    'accent-dim': '#006058',
    'accent-glow': 'rgba(0, 220, 203, 0.45)',
    'deck-a': '#6fcbfe',
    'deck-b': '#feab38',
    'deck-c': '#08e384',
    'deck-d': '#fea2a2',
    play: '#0ce46c',
    'play-glow': 'rgba(12, 228, 108, 0.45)',
    cue: '#feab38',
    'cue-glow': 'rgba(254, 171, 56, 0.45)',
    danger: '#ffa39b',
    loop: '#feab38',
    'wave-low': '#54a0fe',
    'wave-mid': '#faa106',
    'wave-high': '#e9f5ff',
    'chrome-hi': '#42484f',
    'chrome-lo': '#191f25',
    overlay: 'rgba(244, 249, 254, 0.07)',
    'overlay-strong': 'rgba(244, 249, 254, 0.13)',
    thumb: '#3d434a',
    'thumb-hover': '#555c63',
    playhead: '#fafcfe',
    'grid-beat': 'rgba(229, 240, 252, 0.12)',
    'grid-bar': 'rgba(229, 240, 252, 0.3)',
    'grid-phrase': 'rgba(238, 246, 254, 0.5)',
    'clip-body': 'rgba(0, 220, 203, 0.2)',
    'clip-body-on': 'rgba(0, 220, 203, 0.32)',
    'clip-head': 'rgba(0, 220, 203, 0.5)',
    'clip-head-on': 'rgba(0, 220, 203, 0.78)',
    'clip-edge': 'rgba(165, 175, 186, 0.45)',
    'clip-edge-on': 'rgba(0, 220, 203, 0.95)',
    'clip-text': 'rgba(10, 14, 17, 0.95)'
  }),

  theme('paper', 'Paper', 'Warm off-white and a deep sea-blue. Light, never glaring.', {
    'bg-app': '#e9e4da',
    'bg-panel': '#fbf6ec',
    'bg-panel-2': '#f0ece2',
    'bg-raised': '#e6e1d7',
    'bg-raised-hover': '#dbd7cd',
    'bg-pressed': '#d0ccc2',
    'bg-sunken': '#e2ddd4',
    'bg-waveform': '#19160f',
    border: '#a9a499',
    'border-soft': '#d0ccc2',
    'border-strong': '#79746a',
    text: '#0c0a07',
    'text-dim': '#3a362f',
    'text-faint': '#5b564d',
    'text-inverse': '#fefbf6',
    accent: '#00769d',
    'accent-dim': '#004f6a',
    'accent-glow': 'rgba(0, 118, 157, 0.45)',
    'deck-a': '#00769d',
    'deck-b': '#886602',
    'deck-c': '#048149',
    'deck-d': '#c80042',
    play: '#00823a',
    'play-glow': 'rgba(0, 130, 58, 0.45)',
    cue: '#9e5701',
    'cue-glow': 'rgba(158, 87, 1, 0.45)',
    danger: '#ca0221',
    loop: '#9e5701',
    'wave-low': '#60a7ff',
    'wave-mid': '#ffa92b',
    'wave-high': '#eef6fe',
    'chrome-hi': '#f3eee4',
    'chrome-lo': '#cbc7bd',
    overlay: 'rgba(26, 21, 11, 0.07)',
    'overlay-strong': 'rgba(26, 21, 11, 0.13)',
    thumb: '#bbb7ae',
    'thumb-hover': '#9c988f',
    playhead: '#181611',
    'grid-beat': 'rgba(38, 33, 23, 0.12)',
    'grid-bar': 'rgba(38, 33, 23, 0.3)',
    'grid-phrase': 'rgba(26, 21, 11, 0.5)',
    'clip-body': 'rgba(0, 118, 157, 0.16)',
    'clip-body-on': 'rgba(0, 118, 157, 0.26)',
    'clip-head': 'rgba(0, 118, 157, 0.5)',
    'clip-head-on': 'rgba(0, 118, 157, 0.78)',
    'clip-edge': 'rgba(90, 85, 73, 0.45)',
    'clip-edge-on': 'rgba(0, 118, 157, 0.95)',
    'clip-text': 'rgba(255, 251, 244, 0.95)'
  }),

  theme('blossom', 'Blossom', 'Near-black violet under a hot candy pink. Loud, on purpose.', {
    'bg-app': '#120f14',
    'bg-panel': '#1d1b20',
    'bg-panel-2': '#27252a',
    'bg-raised': '#343137',
    'bg-raised-hover': '#403e44',
    'bg-pressed': '#17151a',
    'bg-sunken': '#0b090e',
    'bg-waveform': '#060408',
    border: '#545159',
    'border-soft': '#333036',
    'border-strong': '#7c7881',
    text: '#f5f2f8',
    'text-dim': '#d5d0da',
    'text-faint': '#b9b4bf',
    'text-inverse': '#020103',
    accent: '#ff9bcb',
    'accent-dim': '#940060',
    'accent-glow': 'rgba(255, 155, 203, 0.45)',
    'deck-a': '#ff9bcb',
    'deck-b': '#fead00',
    'deck-c': '#01e296',
    'deck-d': '#adbbff',
    play: '#08e384',
    'play-glow': 'rgba(8, 227, 132, 0.45)',
    cue: '#fead00',
    'cue-glow': 'rgba(254, 173, 0, 0.45)',
    danger: '#ffa39b',
    loop: '#fead00',
    'wave-low': '#968cff',
    'wave-mid': '#fe8cc5',
    'wave-high': '#feeef8',
    'chrome-hi': '#49464d',
    'chrome-lo': '#1f1d22',
    overlay: 'rgba(250, 247, 254, 0.07)',
    'overlay-strong': 'rgba(250, 247, 254, 0.13)',
    thumb: '#444147',
    'thumb-hover': '#5c5960',
    playhead: '#fcfbfe',
    'grid-beat': 'rgba(241, 235, 250, 0.12)',
    'grid-bar': 'rgba(241, 235, 250, 0.3)',
    'grid-phrase': 'rgba(247, 243, 254, 0.5)',
    'clip-body': 'rgba(255, 155, 203, 0.2)',
    'clip-body-on': 'rgba(255, 155, 203, 0.32)',
    'clip-head': 'rgba(255, 155, 203, 0.5)',
    'clip-head-on': 'rgba(255, 155, 203, 0.78)',
    'clip-edge': 'rgba(177, 171, 184, 0.45)',
    'clip-edge-on': 'rgba(255, 155, 203, 0.95)',
    'clip-text': 'rgba(14, 12, 17, 0.95)'
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
