/**
 * What a theme's colours have to hit.
 *
 * A WCAG ratio only reads luminance, so a palette can pass it and still look
 * flat: every surface at nearly the same lightness, or an accent sharing its
 * hue with the ground it sits on. These are the measures that catch that.
 *
 * - APCA Lc, the perceptual contrast WCAG 3 is built on. Unlike WCAG 2 it
 *   knows which colour is on top, which is what makes it usable on dark UI.
 * - OKLCH lightness, chroma and hue, where equal numbers are equal to the eye.
 */
import { THEMES } from './.build/themes.mjs'

const { ok } = globalThis.__t

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** APCA 0.1.9 screen luminance, with its soft clamp near black. */
function screenY(hex) {
  const [r, g, b] = rgb(hex)
  const y = 0.2126729 * r ** 2.4 + 0.7151522 * g ** 2.4 + 0.072175 * b ** 2.4
  return y < 0.022 ? y + (0.022 - y) ** 1.414 : y
}

/** Perceptual contrast of text on a background. Higher is stronger. */
function lc(textHex, bgHex) {
  const t = screenY(textHex)
  const b = screenY(bgHex)
  const s = b > t ? (b ** 0.56 - t ** 0.57) * 1.14 : (b ** 0.65 - t ** 0.62) * 1.14
  return Math.abs(Math.abs(s) < 0.001 ? 0 : s > 0 ? (s - 0.027) * 100 : (s + 0.027) * 100)
}

function oklch(hex) {
  const [R, G, B] = rgb(hex).map(lin)
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  let H = (Math.atan2(b, a) * 180) / Math.PI
  if (H < 0) H += 360
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, C: Math.hypot(a, b), H }
}

/** OKLab coordinates of a hex colour. */
function oklab(hex) {
  const [R, G, B] = rgb(hex).map(lin)
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  }
}

const hex2 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

/** `color-mix(in oklab, a share%, b)`, the same blend the stylesheets ask for. */
function mix(aHex, share, bHex) {
  const a = oklab(aHex)
  const b = oklab(bHex)
  const L = a.L * share + b.L * (1 - share)
  const A = a.a * share + b.a * (1 - share)
  const B = a.b * share + b.b * (1 - share)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return (
    '#' +
    hex2(gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)) +
    hex2(gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)) +
    hex2(gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s))
  )
}

/** Perceptual distance in OKLab: lightness, chroma and hue at once. */
function distance(a, b) {
  const ax = a.C * Math.cos((a.H * Math.PI) / 180)
  const ay = a.C * Math.sin((a.H * Math.PI) / 180)
  const bx = b.C * Math.cos((b.H * Math.PI) / 180)
  const by = b.C * Math.sin((b.H * Math.PI) / 180)
  return Math.hypot(a.L - b.L, ax - bx, ay - by)
}

const hueGap = (a, b) => {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

const SURFACES = ['bg-app', 'bg-panel', 'bg-panel-2', 'bg-raised', 'bg-raised-hover']

/** Text and its ground, with the Lc each pairing has to reach. */
const READABLE = [
  ['text', 'bg-panel', 90],
  ['text', 'bg-app', 90],
  // A raised face carries a control's own short label, not prose.
  ['text', 'bg-raised', 80],
  ['text-dim', 'bg-panel', 75],
  ['text-faint', 'bg-panel', 60],
  ['accent', 'bg-panel', 60],
  // Lit fills carry short bold uppercase, which sits a tier below body text.
  ['text-inverse', 'accent', 65],
  ['text-inverse', 'play', 65],
  ['text-inverse', 'danger', 60],
  // The lane head's switch: its labels sit unlit in a sunken well.
  ['text-faint', 'bg-sunken', 45],
  ['text-faint', 'bg-panel-2', 45],
  ['play', 'bg-panel', 60],
  ['cue', 'bg-panel', 60],
  ['danger', 'bg-panel', 60],
  ['deck-a', 'bg-panel', 60],
  ['deck-b', 'bg-panel', 60],
  ['deck-c', 'bg-panel', 60],
  ['deck-d', 'bg-panel', 60],
  ['wave-high', 'bg-waveform', 75],
  ['wave-mid', 'bg-waveform', 60],
  ['wave-low', 'bg-waveform', 45]
]

ok('there are themes to check', THEMES.length > 0)

for (const theme of THEMES) {
  const t = theme.tokens

  for (const [fg, bg, min] of READABLE) {
    const got = lc(t[fg], t[bg])
    ok(`${theme.name}: ${fg} on ${bg} reads at Lc ${got.toFixed(0)}, needs ${min}`, got >= min)
  }

  // A lane head names its lane with a big letter in the lane's own colour, and
  // drains that letter to --text-faint when the lane is muted. So the drained
  // letter has to be unmistakable against every colour a lane can wear, or a
  // lane whose colour happens to sit near the drained grey would read as muted
  // when it is not.
  const drained = mix(t['text-faint'], 0.65, t['bg-panel-2'])
  for (const deck of ['deck-a', 'deck-b', 'deck-c', 'deck-d']) {
    const worn = mix(t[deck], 0.82, t.text)
    const apart = distance(oklch(drained), oklch(worn))
    ok(`${theme.name}: a muted letter sits ${apart.toFixed(2)} from ${deck}`, apart >= 0.15)
  }

  // Drained, but still saying which lane it is.
  const stillReads = lc(drained, t['bg-panel-2'])
  ok(`${theme.name}: a muted letter still reads at Lc ${stillReads.toFixed(0)}`, stillReads >= 30)

  // Surfaces have to step far enough apart to read as different levels.
  const surfaces = SURFACES.map((s) => oklch(t[s]))
  for (let i = 1; i < surfaces.length; i++) {
    const step = Math.abs(surfaces[i].L - surfaces[i - 1].L)
    ok(
      `${theme.name}: ${SURFACES[i]} steps ${(step * 100).toFixed(1)}% from ${SURFACES[i - 1]}`,
      step >= 0.03
    )
  }

  // A ground may carry colour of its own, but not so much that it competes.
  const surfaceChroma = Math.max(...surfaces.map((s) => s.C))
  ok(`${theme.name}: surfaces hold at chroma ${surfaceChroma.toFixed(3)}`, surfaceChroma <= 0.035)

  // How far apart the accent and its ground look, lightness, chroma and hue
  // together. Distance is what separates them; chroma alone is not.
  const accent = oklch(t.accent)
  const gap = distance(accent, oklch(t['bg-panel']))
  ok(`${theme.name}: the accent sits ${gap.toFixed(2)} from its ground`, gap >= 0.35)

  // An accent sharing its ground's hue reads as a lighter shade of it, so it
  // has to separate — unless the ground is so neutral there is nothing to
  // separate from.
  if (surfaceChroma > 0.02) {
    const gap = hueGap(accent.H, oklch(t['bg-panel']).H)
    ok(`${theme.name}: accent sits ${gap.toFixed(0)} degrees off its ground`, gap >= 40)
  }

  // The four lanes have to be told apart at a glance.
  const decks = ['deck-a', 'deck-b', 'deck-c', 'deck-d'].map((d) => oklch(t[d]))
  for (let i = 0; i < decks.length; i++) {
    for (let j = i + 1; j < decks.length; j++) {
      ok(
        `${theme.name}: deck ${i + 1} and deck ${j + 1} are ${hueGap(decks[i].H, decks[j].H).toFixed(0)} degrees apart`,
        hueGap(decks[i].H, decks[j].H) >= 40
      )
    }
  }
}
