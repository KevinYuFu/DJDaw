/**
 * A channel fader, tapered the way a DAW fader is: silent at the bottom,
 * 0 dB near the top, and a little headroom above it.
 *
 * The travel is not linear in decibels. Most of it is spent between silence
 * and about -12 dB, where a hand needs the resolution, and the last stretch
 * covers the few decibels either side of unity.
 */

/** Loudest the fader goes, in decibels. */
export const FADER_MAX_DB = 6

/** Where 0 dB sits along the travel, 0 at the bottom and 1 at the top. */
export const FADER_UNITY = 0.85

/**
 * Travel to decibels, as a table of points the curve passes through. Between
 * them it runs straight in decibels, which is what a fader's markings do.
 */
const TAPER: ReadonlyArray<readonly [position: number, db: number]> = [
  [0.05, -60],
  [0.12, -48],
  [0.25, -32],
  [0.4, -20],
  [0.55, -12],
  [0.7, -6],
  [FADER_UNITY, 0],
  [1, FADER_MAX_DB]
]

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** Decibels at this point on the travel. The bottom of the fader is silence. */
export function faderGainDb(position: number): number {
  const p = clamp01(position)
  if (p <= TAPER[0][0]) return -Infinity
  for (let i = 1; i < TAPER.length; i++) {
    const [p1, db1] = TAPER[i]
    if (p <= p1) {
      const [p0, db0] = TAPER[i - 1]
      return db0 + ((p - p0) / (p1 - p0)) * (db1 - db0)
    }
  }
  return FADER_MAX_DB
}

/** The same thing as a linear gain, ready for the audio graph. */
export function faderGain(position: number): number {
  const db = faderGainDb(position)
  return db === -Infinity ? 0 : Math.pow(10, db / 20)
}

/** Where a given level sits on the travel, for drawing the marks beside it. */
export function faderPositionForDb(db: number): number {
  if (!Number.isFinite(db)) return 0
  if (db >= FADER_MAX_DB) return 1
  if (db <= TAPER[0][1]) return TAPER[0][0]
  for (let i = 1; i < TAPER.length; i++) {
    const [p1, db1] = TAPER[i]
    if (db <= db1) {
      const [p0, db0] = TAPER[i - 1]
      return p0 + ((db - db0) / (db1 - db0)) * (p1 - p0)
    }
  }
  return 1
}

/** What the fader reads out as, `-inf` at the bottom. */
export function formatFaderDb(position: number): string {
  const db = faderGainDb(position)
  if (db === -Infinity) return '-inf'
  const rounded = Math.abs(db) < 0.05 ? 0 : db
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}`
}

/**
 * Constant-power crossfade: each deck sits at -3 dB in the centre, so a blend
 * of two tracks does not read as a dip in level the way a linear fade does.
 */
export function crossfadeGains(position: number): { A: number; B: number } {
  const t = clamp01(position) * (Math.PI / 2)
  return { A: Math.cos(t), B: Math.sin(t) }
}

/** Crossfader contribution for one deck. Only A and B are on it. */
export function crossfadeGainFor(deck: string, position: number): number {
  const gains = crossfadeGains(position)
  if (deck === 'A') return gains.A
  if (deck === 'B') return gains.B
  return 1
}
