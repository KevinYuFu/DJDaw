/**
 * Splitting a track into stems.
 *
 * The model reads a fixed number of frames at a time, so a track is walked in
 * overlapping segments and faded across the joins. What matters is that every
 * frame is covered and that the fades sum to a flat weight, or the seams show.
 */
import {
  STEM_NAMES,
  STEM_OVERLAP_FRAMES,
  STEM_SEGMENT_FRAMES,
  segmentStarts,
  segmentWindow
} from './.build/stems.mjs'

const { eq, ok } = globalThis.__t

eq('four stems, in the order the model returns them', STEM_NAMES.join(','), 'drums,bass,other,vocals')
eq('the overlap is a quarter of a segment', STEM_OVERLAP_FRAMES, Math.floor(STEM_SEGMENT_FRAMES / 4))

// The fade
{
  const w = segmentWindow(100, 20)
  ok('a segment opens quietly', w[0] > 0 && w[0] < 0.1)
  ok('and closes quietly', w[99] > 0 && w[99] < 0.1)
  ok('but never at nothing, which could not be divided by', w[0] > 0 && w[99] > 0)
  eq('running at full through the middle', w[50], 1)
  ok('rising over the first frames', w[5] > w[1] && w[19] > w[5])
  ok('and falling over the last', w[80] > w[94])
  eq('the fades mirror each other', w[3].toFixed(6), w[96].toFixed(6))
}

eq('no overlap means no fade', segmentWindow(64, 0).every((v) => v === 1), true)
eq('nor does an overlap of one', segmentWindow(64, 1).every((v) => v === 1), true)

// Where the segments start
{
  const seg = 1000
  const over = 250
  const starts = segmentStarts(4000, seg, over)
  eq('the first segment starts at the beginning', starts[0], 0)
  eq('each one steps on by a segment less the overlap', starts[1] - starts[0], seg - over)
  ok('the last segment reaches the end', starts[starts.length - 1] + seg >= 4000)
  ok('and does not start past it', starts[starts.length - 1] < 4000)
}

// Every frame has to be covered, whatever the length.
for (const frames of [1, 999, 1000, 1001, 4000, 44100, 343980, 343981]) {
  const seg = 1000
  const over = 250
  const starts = segmentStarts(frames, seg, over)
  const covered = new Uint8Array(frames)
  for (const s of starts) for (let i = s; i < Math.min(s + seg, frames); i++) covered[i] = 1
  ok(`${frames} frames are covered end to end`, covered.every((c) => c === 1))
}

// The fades either side of a join have to add up to the same weight everywhere,
// which is what the divide by total weight relies on.
{
  const seg = 1000
  const over = 250
  const frames = 5000
  const w = segmentWindow(seg, over)
  const weight = new Float64Array(frames)
  for (const s of segmentStarts(frames, seg, over)) {
    for (let i = 0; i < seg && s + i < frames; i++) weight[s + i] += w[i]
  }
  let least = Infinity
  for (let i = 0; i < frames; i++) least = Math.min(least, weight[i])
  ok('no frame is left with nothing to divide by', least > 0)
}

eq('a track shorter than one segment is still one segment', segmentStarts(10, 1000, 250).length, 1)
