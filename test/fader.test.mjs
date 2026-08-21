/** The channel fader's taper: silence at the bottom, 0 dB near the top. */
import {
  FADER_MAX_DB,
  FADER_UNITY,
  faderGain,
  faderGainDb,
  faderPositionForDb,
  formatFaderDb
} from './.build/fader.mjs'

const { eq, ok } = globalThis.__t

eq('the bottom is silence', faderGainDb(0), -Infinity)
eq('and its gain is zero', faderGain(0), 0)
eq('unity sits where the mark is', faderGainDb(FADER_UNITY), 0, 1e-9)
eq('and unity is a gain of one', faderGain(FADER_UNITY), 1, 1e-9)
eq('the top is the headroom', faderGainDb(1), FADER_MAX_DB, 1e-9)

ok('nothing above the top', faderGainDb(2) === FADER_MAX_DB)
ok('nothing below the bottom', faderGainDb(-1) === -Infinity)

// Louder as it goes up, everywhere.
let last = -Infinity
for (let p = 0.06; p <= 1; p += 0.01) {
  const db = faderGainDb(p)
  ok(`still rising at ${p.toFixed(2)} — ${db.toFixed(2)} dB`, db > last)
  last = db
}

ok('most of the travel is below -12 dB', faderPositionForDb(-12) < 0.6)
ok('the last stretch covers unity', faderPositionForDb(0) > 0.8)

eq('a round trip through decibels holds', faderPositionForDb(faderGainDb(0.5)), 0.5, 1e-9)

eq('silence reads as -inf', formatFaderDb(0), '-inf')
eq('unity reads as 0.0', formatFaderDb(FADER_UNITY), '0.0')
eq('the top reads as +6.0', formatFaderDb(1), '+6.0')
ok('a cut reads negative', formatFaderDb(0.5).startsWith('-'))
