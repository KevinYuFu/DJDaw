/**
 * Mixer channel maths: trim, three-band EQ and the filter knob.
 *
 * Two modes, and each uses the circuit hardware uses for that job:
 *   EQ mode       shelving filters, cutting to -26 dB like a Pioneer DJM
 *                 channel EQ. A shelf at 0 dB is an identity, so a centred
 *                 channel is genuinely transparent.
 *   ISOLATOR mode a crossover-and-sum, cutting to silence like a DJM's
 *                 isolator mode, an Allen & Heath Xone, or EQ Three. Only a
 *                 crossover can truly kill a band; the price is that it
 *                 rotates phase between the bands whatever the knobs say,
 *                 which is what an isolator is.
 * Both modes are offered, as DJ players and mixer hardware do.
 *
 * Every knob is a 0-1 position with 0.5 centred, and everything is a pure
 * function of that, so the mapping is testable without an AudioContext and the
 * offline export reuses it unchanged.
 */

/**
 * Crossover points, in Hz.
 *
 * Crossover frequencies, where the bands split — not shelf corners. 250 Hz and
 * 2.5 kHz sit in the middle of the range mixer hardware uses.
 */
export const CROSSOVER_HZ = { low: 250, high: 2500 } as const

/**
 * Q for each stage of the crossover.
 *
 * A Linkwitz-Riley 24 dB/oct split is two cascaded Butterworth sections, and
 * Butterworth is Q = 1/sqrt(2). LR bands sum flat; a plain Butterworth split
 * leaves a +3 dB bump on each crossover with every band centred.
 */
export const CROSSOVER_Q = Math.SQRT1_2

/**
 * Shelf **corner** frequencies for EQ mode, in Hz.
 *
 * A corner is not a crossover point: a crossover splits the signal in two, a
 * shelf leans on everything past its corner and leaves the rest alone. A shelf
 * at 0 dB is an identity, so a centred channel passes the signal untouched.
 *
 * The numbers are {@link CROSSOVER_HZ}'s, so the low knob moves the same part
 * of the spectrum in either mode.
 */
export const SHELF_CORNER_HZ = { low: CROSSOVER_HZ.low, high: CROSSOVER_HZ.high } as const

/**
 * Centre of the mid bell, in Hz.
 *
 * The geometric mean of the two corners, which is the middle of the mid band by
 * ear: frequency is heard in ratios, so the point equidistant from 250 Hz and
 * 2.5 kHz is 790 Hz, not 1375 Hz.
 */
export const MID_BELL_HZ = Math.sqrt(SHELF_CORNER_HZ.low * SHELF_CORNER_HZ.high)

/**
 * Q of the mid bell. A **real Q factor**, unlike {@link CROSSOVER_Q}, which a
 * Web Audio low-pass reads in decibels.
 *
 * Q is centre frequency over bandwidth, so this is the Q whose half-gain points
 * land on the two shelf corners: the bell covers the band the shelves leave to
 * it and no more. Wider than a mixing EQ's mid, so a full cut on all three
 * knobs reaches the floor the knobs claim.
 */
export const MID_BELL_Q =
  MID_BELL_HZ / (SHELF_CORNER_HZ.high - SHELF_CORNER_HZ.low)

export type EqMode = 'eq' | 'isolator'

/** Full boost, in dB. Both modes, and the same as every mixer worth copying. */
export const EQ_MAX_BOOST_DB = 6

/** Full cut in EQ mode. A channel EQ bottoms out here, short of silence. */
export const EQ_MAX_CUT_DB = -26

/** Trim range, in dB. Not published by Pioneer; derived from LINE input headroom. */
export const TRIM_MIN_DB = -20
export const TRIM_MAX_DB = 9

/** Knob position meaning "no change". */
export const CENTRE = 0.5

/**
 * Filter sweep limits.
 *
 * A DJ filter has to reach the ends to be useful: full left should leave only
 * sub bass, full right only air. The first version stopped at 120 Hz and 9 kHz,
 * which could never get to either end of that.
 */
export const FILTER_BYPASS_HZ = 22000
export const FILTER_LP_MIN_HZ = 30
export const FILTER_HP_MAX_HZ = 18000

/**
 * Filter resonance: a bump at the corner, as hardware filters have. Fixed,
 * with no control mapped to it.
 */
export const FILTER_Q = 1.2

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * dB for a band knob. 0.5 is flat, 1 is full boost, 0 is full cut.
 *
 * In isolator mode a full cut is -Infinity, and {@link bandGain} turns it into
 * a gain of zero. Cut and boost are scaled separately: there is far more cut
 * than boost to cover.
 */
export function eqGainDb(knob: number, mode: EqMode = 'eq'): number {
  const k = clamp01(knob)
  if (k >= CENTRE) return ((k - CENTRE) / CENTRE) * EQ_MAX_BOOST_DB
  if (mode === 'isolator') return k === 0 ? -Infinity : (1 - k / CENTRE) * -60
  return ((CENTRE - k) / CENTRE) * EQ_MAX_CUT_DB
}

/** dB for the trim knob. 0.5 is unity. */
export function trimGainDb(knob: number): number {
  const k = clamp01(knob)
  if (k >= CENTRE) return ((k - CENTRE) / CENTRE) * TRIM_MAX_DB
  return ((CENTRE - k) / CENTRE) * TRIM_MIN_DB
}

/** Linear amplitude for a dB value. -Infinity is silence, not NaN. */
export function dbToGain(db: number): number {
  return db === -Infinity ? 0 : Math.pow(10, db / 20)
}

/** Linear gain for a band knob, ready to drop straight on a GainNode. */
export function bandGain(knob: number, mode: EqMode = 'eq'): number {
  return dbToGain(eqGainDb(knob, mode))
}

export type FilterMode = 'lowpass' | 'highpass'

export interface FilterSetting {
  type: FilterMode
  frequency: number
  /** Q to apply. Flat at the centre so a parked knob adds no colour. */
  q: number
  /** True when the knob is centred and the filter should be inaudible. */
  bypassed: boolean
}

/**
 * The filter knob is one control covering two filters, as on a DJM: centred is
 * off, left sweeps a low-pass down, right sweeps a high-pass up.
 *
 * The sweep is exponential, as pitch is. Resonance fades in with it, so a
 * parked knob stays clean.
 */
export function filterSetting(knob: number): FilterSetting {
  const k = clamp01(knob)
  const offset = k - CENTRE
  // A small dead zone, so resting near the middle is genuinely flat.
  if (Math.abs(offset) < 0.02) {
    return { type: 'lowpass', frequency: FILTER_BYPASS_HZ, q: Math.SQRT1_2, bypassed: true }
  }
  const t = Math.min(1, Math.abs(offset) / CENTRE)
  const q = Math.SQRT1_2 + (FILTER_Q - Math.SQRT1_2) * t
  if (offset < 0) {
    return {
      type: 'lowpass',
      frequency: FILTER_BYPASS_HZ * Math.pow(FILTER_LP_MIN_HZ / FILTER_BYPASS_HZ, t),
      q,
      bypassed: false
    }
  }
  return {
    type: 'highpass',
    frequency: 20 * Math.pow(FILTER_HP_MAX_HZ / 20, t),
    q,
    bypassed: false
  }
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

/** Readout for a knob, e.g. `+3.0 dB`, `KILL`, `0.0 dB`. */
export function formatDb(db: number): string {
  if (db === -Infinity) return 'KILL'
  if (db <= EQ_MAX_CUT_DB + 0.05 && db > -30) return `${EQ_MAX_CUT_DB} dB`
  if (db <= -30) return `${Math.round(db)} dB`
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
