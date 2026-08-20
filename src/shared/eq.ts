/**
 * Mixer channel maths: trim, three-band EQ and the filter knob.
 *
 * The EQ is a crossover-and-sum, not shelving filters. The signal is split into
 * three bands, each band gets its own gain, and they are summed. That is how
 * Ableton's EQ Three and every hardware isolator work, and it is the only
 * topology that can truly kill a band — a shelf can only ever lean on one.
 *
 * Two floors, because DJ hardware has two:
 *   EQ mode       cuts to -26 dB, which is what a Pioneer DJM channel EQ does
 *   ISOLATOR mode cuts to silence, which is what a DJM's isolator mode, an
 *                 Allen & Heath Xone, and EQ Three all do
 * rekordbox exposes exactly this as a preference, and Kevin's DDJ-FLX10 has an
 * isolator mode on shift+CUE, so both belong here.
 *
 * Every knob is a 0-1 position with 0.5 centred, and everything is a pure
 * function of that, so the mapping is testable without an AudioContext and the
 * offline export reuses it unchanged.
 */

/**
 * Crossover points, in Hz.
 *
 * These are crossover frequencies, not shelf corners — the distinction matters,
 * and getting it wrong is what made the first version feel unlike a controller.
 * 250 Hz / 2.5 kHz are Ableton EQ Three's defaults and sit in the middle of the
 * range hardware uses (Allen & Heath's Xone:96 publishes 180 Hz / 3 kHz).
 *
 * Pioneer quotes its channel EQ as 70 Hz / 1 kHz / 13 kHz, but those are the
 * centres of shelving and bell filters, not splits, so they are not the numbers
 * to use here.
 */
export const CROSSOVER_HZ = { low: 250, high: 2500 } as const

/**
 * Q for each stage of the crossover.
 *
 * A Linkwitz-Riley 24 dB/oct split is two cascaded Butterworth sections, and
 * Butterworth is Q = 1/sqrt(2). LR is used rather than plain Butterworth
 * because LR bands sum flat: a Butterworth split leaves a +3 dB bump sitting on
 * each crossover even with every band centred, which is exactly the artefact
 * EQ Three is measured to have.
 */
export const CROSSOVER_Q = Math.SQRT1_2

export type EqMode = 'eq' | 'isolator'

/** Full boost, in dB. Both modes, and the same as every mixer worth copying. */
export const EQ_MAX_BOOST_DB = 6

/** Full cut in EQ mode. A DJM channel EQ bottoms out here rather than at silence. */
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
 * Filter resonance. Hardware filters have a bump at the corner; a flat
 * Butterworth sweep sounds inert next to one. Fixed rather than exposed,
 * because the FLX10 has no per-channel resonance control to map it to.
 */
export const FILTER_Q = 1.2

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * dB for a band knob. 0.5 is flat, 1 is full boost, 0 is full cut.
 *
 * In isolator mode a full cut is -Infinity, which is a real value to return
 * here: {@link bandGain} turns it into a gain of exactly zero. Cut and boost
 * are scaled separately because a mixer gives far more cut than boost, and
 * pretending otherwise wastes half the knob's travel.
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
 * The sweep is exponential because pitch is. A linear sweep spends most of its
 * travel in the top octave, where nothing audible happens. Resonance fades in
 * with the sweep so a parked knob stays clean.
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
