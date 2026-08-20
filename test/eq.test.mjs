/**
 * Mixer knob mapping.
 *
 * These are the numbers that decide whether the EQ feels like a DJM or like a
 * software plugin. Centre must be exactly flat, cut must go much further than
 * boost, and the filter must sweep by ear rather than by pixel.
 */
import * as E from './.build/eq.mjs'

const { eq, ok } = globalThis.__t

// Centre is dead flat. Anything else and a "neutral" channel colours the sound.
eq('a centred EQ knob is exactly 0 dB', E.eqGainDb(0.5), 0)
eq('a centred trim is exactly 0 dB', E.trimGainDb(0.5), 0)
eq('0 dB is unity gain', E.dbToGain(0), 1)

eq('full boost', E.eqGainDb(1), E.EQ_MAX_BOOST_DB)
eq('full cut in EQ mode', E.eqGainDb(0), E.EQ_MAX_CUT_DB)
eq('half way up is half the boost', E.eqGainDb(0.75), E.EQ_MAX_BOOST_DB / 2)
eq('half way down is half the cut', E.eqGainDb(0.25), E.EQ_MAX_CUT_DB / 2)

// Isolator mode: a full cut is silence, which is the whole point of it.
eq('isolator full cut is minus infinity', E.eqGainDb(0, 'isolator'), -Infinity)
eq('and that turns into a gain of exactly zero', E.bandGain(0, 'isolator'), 0)
eq('isolator centre is still flat', E.eqGainDb(0.5, 'isolator'), 0)
eq('and unity gain', E.bandGain(0.5, 'isolator'), 1)
eq('isolator boosts the same as EQ mode', E.eqGainDb(1, 'isolator'), E.EQ_MAX_BOOST_DB)
ok('isolator cuts harder than EQ mode part way down',
  E.eqGainDb(0.25, 'isolator') < E.eqGainDb(0.25, 'eq'))
ok('EQ mode never reaches silence', E.bandGain(0, 'eq') > 0)

// Cut and boost are deliberately asymmetric, the way a mixer is.
ok('cut goes much further than boost', Math.abs(E.EQ_MAX_CUT_DB) > E.EQ_MAX_BOOST_DB * 3)
ok('a full cut is nearly silent', E.dbToGain(E.eqGainDb(0)) < 0.06)
ok('but not actually silent, since this is an EQ not a mute', E.dbToGain(E.eqGainDb(0)) > 0)

// Knob positions out of range must not produce absurd gains.
eq('below zero clamps to full cut', E.eqGainDb(-5), E.EQ_MAX_CUT_DB)
eq('and to silence in isolator mode', E.bandGain(-5, 'isolator'), 0)
eq('above one clamps to full boost', E.eqGainDb(9), E.EQ_MAX_BOOST_DB)

eq('full trim boost', E.trimGainDb(1), E.TRIM_MAX_DB)
eq('full trim cut', E.trimGainDb(0), E.TRIM_MIN_DB)
ok('trim cut is negative', E.trimGainDb(0.1) < 0)
ok('trim boost is positive', E.trimGainDb(0.9) > 0)

// EQ is monotonic. A knob that does not move in one direction is broken.
{
  let prev = -Infinity
  let monotonic = true
  for (let i = 0; i <= 100; i++) {
    const db = E.eqGainDb(i / 100)
    if (db < prev - 1e-9) monotonic = false
    prev = db
  }
  ok('turning the knob up never lowers the gain', monotonic)
}

// Crossovers, not shelf corners.
ok('the low crossover is in the bass/low-mid region',
  E.CROSSOVER_HZ.low >= 150 && E.CROSSOVER_HZ.low <= 350)
ok('the high crossover is in the presence region',
  E.CROSSOVER_HZ.high >= 2000 && E.CROSSOVER_HZ.high <= 4000)
ok('and they are a long way apart', E.CROSSOVER_HZ.high / E.CROSSOVER_HZ.low > 5)
eq('crossover Q is Butterworth, for a Linkwitz-Riley pair', E.CROSSOVER_Q, Math.SQRT1_2)

// The filter knob.
{
  const centre = E.filterSetting(0.5)
  ok('a centred filter is bypassed', centre.bypassed)
  ok('and sits above the audible range', centre.frequency >= 20000)

  const nudged = E.filterSetting(0.51)
  ok('a tiny nudge is still bypassed, so resting near centre is flat', nudged.bypassed)

  const lp = E.filterSetting(0.2)
  eq('left of centre is a low-pass', lp.type, 'lowpass')
  ok('and it is doing something', !lp.bypassed && lp.frequency < 20000)

  const hp = E.filterSetting(0.8)
  eq('right of centre is a high-pass', hp.type, 'highpass')
  ok('and it is doing something', !hp.bypassed && hp.frequency > 20)

  eq('fully left reaches the low-pass floor', Math.round(E.filterSetting(0).frequency), E.FILTER_LP_MIN_HZ)
  eq('fully right reaches the high-pass ceiling', Math.round(E.filterSetting(1).frequency), E.FILTER_HP_MAX_HZ)

  // The sweep has to reach both ends to be usable: full left leaves only sub,
  // full right only air. The first version stopped at 120 Hz and 9 kHz.
  ok('the low-pass sweeps below the bass', E.filterSetting(0).frequency < 60)
  ok('the high-pass sweeps above the presence range', E.filterSetting(1).frequency > 15000)

  // Resonance fades in with the sweep so a parked knob stays clean.
  eq('a centred filter has no resonance bump', E.filterSetting(0.5).q, Math.SQRT1_2)
  ok('a swept filter has some', E.filterSetting(0).q > Math.SQRT1_2)
  ok('and not a screaming amount', E.filterSetting(0).q <= 2)

  // The sweep is exponential: equal knob movements should be roughly equal
  // musical intervals, not equal Hz.
  const a = E.filterSetting(0.4).frequency
  const b = E.filterSetting(0.3).frequency
  const c = E.filterSetting(0.2).frequency
  const ratio1 = a / b
  const ratio2 = b / c
  ok('the low-pass sweeps by ratio, not by hertz', Math.abs(ratio1 - ratio2) < 0.35)
  ok('and always downward as the knob turns left', a > b && b > c)
}

// Filters are monotonic too, in the direction that matters.
{
  let prev = Infinity
  let ok1 = true
  for (let i = 0; i <= 48; i++) {
    const f = E.filterSetting(0.48 - (i / 48) * 0.48).frequency
    if (f > prev + 1e-6) ok1 = false
    prev = f
  }
  ok('the low-pass only ever sweeps down', ok1)
}

// Channel state.
{
  const flat = E.flatChannel()
  ok('a fresh channel is flat', E.isFlat(flat))
  eq('every knob starts centred', Object.values(flat).every((v) => v === 0.5), true)
  ok('nudging one knob makes it not flat', !E.isFlat({ ...flat, low: 0.2 }))
  eq('and a flat channel changes nothing', E.dbToGain(E.eqGainDb(flat.low)), 1)
}

// Readouts. These sit under the knobs, so they have to be short and honest.
eq('centre reads as zero', E.formatDb(0).trim(), '0.0 dB')
eq('a boost is signed', E.formatDb(3), '+3.0 dB')
eq('a cut is signed', E.formatDb(-4.2), '-4.2 dB')
eq('a full cut reads as the floor', E.formatDb(E.EQ_MAX_CUT_DB), '-26 dB')
eq('silence reads as KILL', E.formatDb(-Infinity), 'KILL')
eq('a bypassed filter reads OFF', E.formatFilter(0.5), 'OFF')
ok('a low-pass names itself', E.formatFilter(0.2).startsWith('LPF'))
ok('a high-pass names itself', E.formatFilter(0.8).startsWith('HPF'))
ok('and gives a frequency', /\d/.test(E.formatFilter(0.2)))
