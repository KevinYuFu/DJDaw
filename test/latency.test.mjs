/**
 * Output latency.
 *
 * The playhead has to show the audio leaving the speakers, not the audio being
 * rendered, or the beat grid sits off the music by the device's latency.
 */
import { audibleTime, outputLatencySec } from './.build/latency.mjs'

const { eq, ok } = globalThis.__t

eq('a context reporting no latency needs no correction', outputLatencySec({}), 0)
eq('nor does one reporting zero', outputLatencySec({ outputLatency: 0 }), 0)
eq('a reported latency is taken as it is', outputLatencySec({ outputLatency: 0.014 }), 0.014)

// A figure that cannot be true is worse than none: it would drag the playhead
// somewhere else entirely.
eq('a negative figure is ignored', outputLatencySec({ outputLatency: -0.02 }), 0)
eq('NaN is ignored', outputLatencySec({ outputLatency: NaN }), 0)
eq('Infinity is ignored', outputLatencySec({ outputLatency: Infinity }), 0)
eq('an absurd figure is capped', outputLatencySec({ outputLatency: 30 }), 1)

// The audible clock trails the render clock by exactly the latency.
eq('the audible clock trails the render clock', audibleTime(10, 0.014), 9.986)
eq('and matches it when there is no latency', audibleTime(10, 0), 10)

// What this is worth in beats, which is what a DJ sees.
{
  const lag = 0.014
  const beatAt = (bpm) => 60 / bpm
  ok('at 140 bpm the correction is under a twentieth of a beat', lag / beatAt(140) < 0.05)
  ok('but not so small it is nothing', lag / beatAt(140) > 0.02)
}

// A deck reports a frame stamped with the render time it was true. Reading the
// position at the audible clock has to walk that frame back, not forward.
{
  const frameAt = (snap, fileRate, at) =>
    snap.rate === 0 ? snap.frame : snap.frame + (at - snap.ctxTime) * snap.rate * fileRate
  const snap = { frame: 44100, ctxTime: 10, rate: 1 }
  const rendered = frameAt(snap, 44100, 10.5)
  const audible = frameAt(snap, 44100, audibleTime(10.5, 0.014))
  eq('the render clock reads half a second on', rendered, 44100 + 22050)
  ok('the audible one reads earlier', audible < rendered)
  eq('by exactly the latency in frames', Math.round(rendered - audible), Math.round(0.014 * 44100))
}

// A stopped deck does not move, whatever the latency is.
{
  const frameAt = (snap, fileRate, at) =>
    snap.rate === 0 ? snap.frame : snap.frame + (at - snap.ctxTime) * snap.rate * fileRate
  const snap = { frame: 12345, ctxTime: 10, rate: 0 }
  eq('a paused deck holds still', frameAt(snap, 44100, audibleTime(99, 0.014)), 12345)
}
