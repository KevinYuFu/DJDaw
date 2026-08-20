/**
 * Mixer channel maths: trim, three-band EQ and the filter knob.
 *
 * Modelled on a Pioneer DJM, because that is what the muscle memory is built
 * on. Every knob is a 0-1 position with 0.5 centred, and everything here is a
 * pure function of that position, so the mapping can be tested without an
 * AudioContext and reused by an offline render later.
 */

/** Crossover points for the three bands, in Hz. */
export const EQ_FREQUENCIES = { low: 200, mid: 1000, high: 4000 } as const

export type EqBand = keyof typeof EQ_FREQUENCIES

/** Width of the mid bell. Wide enough to feel like a mixer, not a notch. */
export const EQ_MID_Q = 0.9

/** Full boost, in dB. A DJM gives about +6 and so do we. */
export const EQ_MAX_BOOST_DB = 6

/**
 * Full cut, in dB.
 *
 * A DJM's EQ cuts to roughly -26 dB; only its isolator mode goes to silence.
 * Matching that keeps a full cut sounding like the hardware rather than like a
 * mute. True isolator-style kill needs a crossover rather than shelves and is
 * not built.
 */
export const EQ_MAX_CUT_DB = -26

/** Trim range, in dB. */
export const TRIM_MIN_DB = -20
export const TRIM_MAX_DB = 9

/** Knob position meaning "no change" for EQ and trim. */
export const CENTRE = 0.5

/** Frequency the filter sits at when it is doing nothing. */
export const FILTER_BYPASS_HZ = 21000
/** Lowest the low-pass sweeps to, and highest the high-pass sweeps to. */
export const FILTER_LP_MIN_HZ = 120
export const FILTER_HP_MAX_HZ = 9000

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * dB for an EQ knob. 0.5 is flat, 1 is full boost, 0 is full cut.
 *
 * Cut and boost are scaled separately because they are not symmetric: a mixer
 * gives you far more cut than boost, and pretending otherwise makes the top
 * half of the knob useless.
 */
export function eqGainDb(knob: number): number {
  const k = clamp01(knob)
  if (k >= CENTRE) return ((k - CENTRE) / CENTRE) * EQ_MAX_BOOST_DB
  return ((CENTRE - k) / CENTRE) * EQ_MAX_CUT_DB
}

/** dB for the trim knob. 0.5 is unity. */
export function trimGainDb(knob: number): number {
  const k = clamp01(knob)
  if (k >= CENTRE) return ((k - CENTRE) / CENTRE) * TRIM_MAX_DB
  return ((CENTRE - k) / CENTRE) * TRIM_MIN_DB
}

/** Linear amplitude for a dB value. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

export type FilterMode = 'lowpass' | 'highpass'

export interface FilterSetting {
  type: FilterMode
  frequency: number
  /** True when the knob is centred and the filter should be inaudible. */
  bypassed: boolean
}

/**
 * The filter knob is one control covering two filters, as on a DJM: centred is
 * off, left sweeps a low-pass down, right sweeps a high-pass up.
 *
 * The sweep is exponential because pitch is. A linear sweep spends most of its
 * travel in the top octave, where nothing audible happens.
 */
export function filterSetting(knob: number): FilterSetting {
  const k = clamp01(knob)
  const offset = k - CENTRE
  // A small dead zone around the centre, so resting the knob near the middle
  // is genuinely flat rather than very slightly filtered.
  if (Math.abs(offset) < 0.02) {
    return { type: 'lowpass', frequency: FILTER_BYPASS_HZ, bypassed: true }
  }
  if (offset < 0) {
    const t = Math.min(1, -offset / CENTRE)
    const frequency = FILTER_BYPASS_HZ * Math.pow(FILTER_LP_MIN_HZ / FILTER_BYPASS_HZ, t)
    return { type: 'lowpass', frequency, bypassed: false }
  }
  const t = Math.min(1, offset / CENTRE)
  const frequency = 20 * Math.pow(FILTER_HP_MAX_HZ / 20, t)
  return { type: 'highpass', frequency, bypassed: false }
}

/** One channel's full knob state. 0.5 everywhere is a flat channel. */
export interface ChannelEq {
  trim: number
  low: number
  mid: number
  high: number
  filter: number
}

export function flatChannel(): ChannelEq {
  return { trim: CENTRE, low: CENTRE, mid: CENTRE, high: CENTRE, filter: CENTRE }
}

/** True when every knob is centred, i.e. the channel is doing nothing. */
export function isFlat(eq: ChannelEq): boolean {
  return (
    eq.trim === CENTRE &&
    eq.low === CENTRE &&
    eq.mid === CENTRE &&
    eq.high === CENTRE &&
    eq.filter === CENTRE
  )
}

/** Readout for a knob, e.g. `+3.0 dB`, `-26 dB`, `0.0 dB`. */
export function formatDb(db: number): string {
  if (db <= EQ_MAX_CUT_DB + 0.05) return `${EQ_MAX_CUT_DB} dB`
  const sign = db > 0.05 ? '+' : db < -0.05 ? '' : ' '
  return `${sign}${db.toFixed(1)} dB`
}

/** Readout for the filter knob. */
export function formatFilter(knob: number): string {
  const setting = filterSetting(knob)
  if (setting.bypassed) return 'OFF'
  const hz = setting.frequency
  const value = hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}`
  return `${setting.type === 'lowpass' ? 'LPF' : 'HPF'} ${value}`
}
