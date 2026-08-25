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
    'thumb-hover': '#4d5460'
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
    'thumb-hover': '#454f7c'
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
    'thumb-hover': '#5b5243'
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
    'thumb-hover': '#5d6673'
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
