/**
 * Time stretching that leaves the pitch alone.
 *
 * The two things that matter: the result is the length it was asked for, and
 * every tone in it still sounds at the frequency it did. A speed change would
 * get the first right and the second wrong, which is exactly the difference.
 */
import { FFT_SIZE, stretchChannel, stretchChannels } from './.build/stretch.mjs'
import { needsWarp, warpFactor } from './.build/warp.mjs'

const { eq, ok } = globalThis.__t

const SR = 48000

/** A steady tone. */
const tone = (hz, seconds, amp = 0.5) => {
  const out = new Float32Array(Math.round(seconds * SR))
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / SR) * amp
  return out
}

/** The loudest frequency in a signal, by counting rising zero crossings. */
const pitchOf = (x, from = 0.2, to = 0.8) => {
  const a = Math.floor(x.length * from)
  const b = Math.floor(x.length * to)
  let crossings = 0
  for (let i = a + 1; i < b; i++) if (x[i - 1] <= 0 && x[i] > 0) crossings++
  return (crossings * SR) / (b - a)
}

/** Loudness, for checking the level survives. */
const rms = (x, from = 0.2, to = 0.8) => {
  const a = Math.floor(x.length * from)
  const b = Math.floor(x.length * to)
  let sum = 0
  for (let i = a; i < b; i++) sum += x[i] * x[i]
  return Math.sqrt(sum / (b - a))
}

// --- longer, and slower -------------------------------------------------
{
  // 175 into 150 is the case that matters: the file has to become 1.167 times
  // as long, and still sound at the same pitch.
  const factor = 175 / 150
  const input = tone(440, 3)
  const out = stretchChannel(input, factor)
  eq('it comes out the length it was asked for', out.length, Math.round(input.length * factor))
  const before = pitchOf(input)
  const after = pitchOf(out)
  ok(`the tone is still at its own pitch — ${before.toFixed(1)}Hz became ${after.toFixed(1)}Hz`,
    Math.abs(after - before) / before < 0.02)
  ok(`and it is still as loud — ${rms(input).toFixed(3)} against ${rms(out).toFixed(3)}`,
    Math.abs(rms(out) - rms(input)) / rms(input) < 0.25)
}

// --- shorter, and faster -------------------------------------------------
{
  const factor = 128 / 150
  const input = tone(220, 3)
  const out = stretchChannel(input, factor)
  eq('a shorter one is the right length too', out.length, Math.round(input.length * factor))
  ok(`its pitch is unmoved as well — ${pitchOf(out).toFixed(1)}Hz`,
    Math.abs(pitchOf(out) - pitchOf(input)) / pitchOf(input) < 0.02)
}

// --- what a speed change would have done ---------------------------------
{
  // Resampling to the same length drops the pitch by the same ratio. This is
  // the thing the stretcher exists to avoid, so it is worth pinning down.
  const factor = 175 / 150
  const input = tone(440, 2)
  const resampled = new Float32Array(Math.round(input.length * factor))
  for (let i = 0; i < resampled.length; i++) resampled[i] = input[Math.floor(i / factor)]
  const bent = pitchOf(resampled)
  const kept = pitchOf(stretchChannel(input, factor))
  ok(`a speed change would have dropped it to ${bent.toFixed(0)}Hz; stretching keeps ${kept.toFixed(0)}Hz`,
    Math.abs(bent - 440 / factor) / (440 / factor) < 0.03 && Math.abs(kept - 440) / 440 < 0.02)
}

// --- the boring cases ----------------------------------------------------
{
  const input = tone(300, 1)
  eq('a factor of one hands the audio straight back', stretchChannel(input, 1).length, input.length)
  eq('and it is the same audio', stretchChannel(input, 1)[1000], input[1000])
  eq('a clip shorter than one window is left alone',
    stretchChannel(new Float32Array(FFT_SIZE - 1), 2).length, (FFT_SIZE - 1) * 2)
  eq('a nonsense factor changes nothing', stretchChannel(input, 0).length, 1)
  eq('every channel is stretched the same way',
    stretchChannels([tone(200, 1), tone(300, 1)], 1.5).map((c) => c.length).join(','),
    `${Math.round(SR * 1.5)},${Math.round(SR * 1.5)}`)
}

// --- what warping asks for -----------------------------------------------
{
  // 175 onto a 150 master has to become 175/150 times as long, at the same
  // pitch: the beats then land where the master's do.
  eq('a faster file is stretched longer', +warpFactor(175, 150).toFixed(4), 1.1667)
  eq('a slower one is squeezed shorter', +warpFactor(128, 150).toFixed(4), 0.8533)
  eq('the same tempo is left alone', warpFactor(150, 150), 1)
  eq('an unknown tempo is left alone too', warpFactor(0, 150), 1)
  ok('a different tempo needs warping', needsWarp(175, 150))
  ok('the same tempo does not', !needsWarp(150, 150))
  ok('nor does one hundredth of a beat', !needsWarp(150.005, 150))
  ok('and an unknown tempo is never warped', !needsWarp(0, 150) && !needsWarp(150, 0))

  // The point of all of it: a file warped onto a master lasts exactly as many
  // beats as it did.
  const beatsBefore = (240 * 175) / 60
  const stretched = 240 * warpFactor(175, 150)
  const beatsAfter = (stretched * 150) / 60
  ok(`a four minute 175 track keeps its ${beatsBefore} beats at 150 — ${beatsAfter.toFixed(1)}`,
    Math.abs(beatsAfter - beatsBefore) < 0.01)
}

// --- a stereo file goes through in one pass -------------------------------
{
  // Both channels ride through the same transforms, so the two have to come
  // out exactly as they would have done one at a time.
  const left = tone(440, 2, 0.5)
  const right = tone(660, 2, 0.3)
  const factor = 175 / 150
  const [pl, pr] = stretchChannels([left, right], factor)
  const sl = stretchChannel(left, factor)
  const sr = stretchChannel(right, factor)
  eq('both come out the right length', `${pl.length},${pr.length}`, `${sl.length},${sr.length}`)

  const diff = (a, b) => {
    let worst = 0
    const from = Math.floor(a.length * 0.2)
    const to = Math.floor(a.length * 0.8)
    for (let i = from; i < to; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
    return worst
  }
  ok(`the left channel matches doing it alone — worst ${diff(pl, sl).toFixed(5)}`, diff(pl, sl) < 0.002)
  ok(`and the right one does too — worst ${diff(pr, sr).toFixed(5)}`, diff(pr, sr) < 0.002)
  ok(`the two channels stay apart — left ${pitchOf(pl).toFixed(0)}Hz, right ${pitchOf(pr).toFixed(0)}Hz`,
    Math.abs(pitchOf(pl) - 440) / 440 < 0.02 && Math.abs(pitchOf(pr) - 660) / 660 < 0.02)
  ok(`and keep their own levels — ${rms(pl).toFixed(3)} and ${rms(pr).toFixed(3)}`,
    Math.abs(rms(pl) - rms(left)) / rms(left) < 0.1 && Math.abs(rms(pr) - rms(right)) / rms(right) < 0.1)

  eq('a mono file still goes through on its own', stretchChannels([left], factor).length, 1)
  eq('and so does anything that is not a pair', stretchChannels([left, right, left], factor).length, 3)
}
