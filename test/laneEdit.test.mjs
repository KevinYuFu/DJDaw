/**
 * Laying clips onto a lane.
 *
 * A clip is a window onto a source. The thing that matters here is that the
 * audio under a clip never shifts: whenever a piece keeps part of what it had,
 * `offsetSamples` moves by exactly as much as its start did.
 */
import { endOf, hiddenFrames, layOver, MIN_CLIP_FRAMES, trimTo, trimWithin } from './.build/laneEdit.mjs'

const { eq, ok } = globalThis.__t

let n = 0
const newId = () => `new-${++n}`

/**
 * A clip showing part of a source. Sizes are in frames and scaled up by `U`,
 * so a leftover sliver is a sliver rather than something under the floor.
 */
const U = 1000
const clip = (id, start, duration, offset = 0, source = 1000) => ({
  id,
  startSample: start * U,
  durationSamples: duration * U,
  offsetSamples: offset * U,
  sourceDurationSamples: source * U,
  startTick: 12345,
  sourceId: 'song'
})

/** Which frame of the source is heard at arrangement frame `at`. */
const sourceFrameAt = (c, at) => c.offsetSamples + (at - c.startSample)

eq('a clip ends where its duration runs out', endOf(clip('a', 100, 50)), 150 * U)

// ---------------------------------------------------------------- trimming

{
  const c = clip('a', 200, 100, 50)
  const h = hiddenFrames(c)
  eq('the source before the window is hidden', h.before, 50 * U)
  eq('and so is what follows it', h.after, (1000 - 50 - 100) * U)
}

{
  // The four-bar loop cut in half, then pulled back out.
  const half = clip('a', 0, 100, 0, 200)
  const whole = trimTo(half, 'right', 200 * U)
  eq('the right edge reveals what follows', whole.durationSamples, 200 * U)
  eq('without moving the start', whole.startSample, 0)
  eq('or what it starts on in the source', whole.offsetSamples, 0)
}

{
  const c = clip('a', 100, 100, 0, 1000)
  eq('the right edge stops at the end of the source', trimTo(c, 'right', 5000 * U).durationSamples, 1000 * U)
  eq('and cannot shorten past nothing', trimTo(c, 'right', 100 * U).durationSamples, MIN_CLIP_FRAMES)
}

{
  // Pulling the left edge back has to reveal audio, not slide it.
  const c = clip('a', 500, 100, 200)
  const out = trimTo(c, 'left', 400 * U)
  eq('the start moves back', out.startSample, 400 * U)
  eq('the offset moves with it', out.offsetSamples, 100 * U)
  eq('so the clip gets longer', out.durationSamples, 200 * U)
  eq('and the audio at the old start is unmoved', sourceFrameAt(out, 500 * U), sourceFrameAt(c, 500 * U))
}

{
  const c = clip('a', 500, 100, 200)
  eq('the left edge stops where the source starts', trimTo(c, 'left', 0).startSample, 300 * U)
  eq('taking the offset to zero', trimTo(c, 'left', 0).offsetSamples, 0)
  const shrunk = trimTo(c, 'left', 599 * U)
  ok('and cannot pass its own end', shrunk.durationSamples >= MIN_CLIP_FRAMES)
}

{
  const c = clip('a', 100, 100, 50)
  ok('a trimmed clip drops its stale tick', !('startTick' in trimTo(c, 'right', 150 * U)))
}

// ------------------------------------------------------------- laying over

{
  const lane = [clip('a', 0, 100), clip('b', 400, 100)]
  const out = layOver(lane, clip('n', 200, 100), newId)
  eq('a clip landing in a gap disturbs nothing', out.length, 3)
  eq('and the lane stays in start order', out.map((c) => c.id).join(','), 'a,n,b')
}

{
  const lane = [clip('a', 0, 100), clip('b', 100, 100)]
  const out = layOver(lane, clip('n', 100, 100), newId)
  eq('a clip landing exactly on another replaces it', out.length, 2)
  eq('and the one it covered is gone', out.some((c) => c.id === 'b'), false)
}

{
  const lane = [clip('a', 0, 200, 0)]
  const out = layOver(lane, clip('n', 150, 200), newId)
  eq('a clip over the tail of another leaves the head', out.length, 2)
  eq('shortened to where the new one starts', out[0].durationSamples, 150 * U)
  eq('with the head still starting where it did', out[0].offsetSamples, 0)
}

{
  const lane = [clip('a', 100, 200, 30)]
  const out = layOver(lane, clip('n', 0, 150), newId)
  const kept = out.find((c) => c.id === 'a')
  eq('a clip over the head of another leaves the tail', out.length, 2)
  eq('starting where the new one ends', kept.startSample, 150 * U)
  eq('showing the source from that point', kept.offsetSamples, (30 + 50) * U)
  eq('and the audio there is what it always was', sourceFrameAt(kept, 200 * U), sourceFrameAt(clip('a', 100, 200, 30), 200 * U))
}

{
  // Landing inside a clip leaves the two ends of it.
  const lane = [clip('a', 0, 400, 100)]
  const out = layOver(lane, clip('n', 150, 100), newId)
  eq('a clip landing inside another leaves two pieces', out.length, 3)
  const [before, laid, after] = out
  eq('the first ends where the new one starts', endOf(before), 150 * U)
  eq('the new one sits between them', laid.id, 'n')
  eq('the last starts where the new one ends', after.startSample, 250 * U)
  eq('and both pieces point at the same source', before.sourceId === after.sourceId, true)
  eq('the far piece shows the source from the right place', after.offsetSamples, (100 + 250) * U)
  ok('the two pieces have different ids', before.id !== after.id)
}

{
  const lane = [clip('a', 0, 100), clip('b', 100, 100), clip('c', 200, 100)]
  const out = layOver(lane, clip('n', 50, 200), newId)
  eq('a clip over several takes them all', out.map((c) => c.id).join(','), 'a,n,c')
  eq('trimming the one it starts in', out[0].durationSamples, 50 * U)
  eq('and the one it ends in', out[2].startSample, 250 * U)
}

{
  // A sliver too short to hear is dropped rather than left behind.
  const lane = [clip('a', 0, 200)]
  const out = layOver(lane, { ...clip('n', 0, 300), startSample: MIN_CLIP_FRAMES - 1 }, newId)
  eq('a sliver left over is dropped', out.length, 1)
  eq('leaving only the clip put down', out[0].id, 'n')
}

{
  const lane = [clip('a', 0, 100)]
  const moved = { ...clip('a', 500, 100), startTick: 999 }
  const out = layOver(lane, moved, newId)
  eq('a clip laid over itself is not duplicated', out.length, 1)
  eq('and it lands where it was put', out[0].startSample, 500 * U)
  ok('with its stale tick dropped', !('startTick' in out[0]))
}

// --------------------------------------------------- trimming over a neighbour

{
  const lane = [clip('a', 0, 100, 0, 1000), clip('b', 100, 100, 0, 1000)]
  const out = trimWithin(lane, 'a', 'right', 160 * U, newId)
  eq('growing a clip pushes into its neighbour', out.length, 2)
  eq('the grown clip keeps what it asked for', out[0].durationSamples, 160 * U)
  eq('and the neighbour starts after it', out[1].startSample, 160 * U)
  eq('showing its source from further in', out[1].offsetSamples, 60 * U)
}

{
  const lane = [clip('a', 0, 100, 0, 1000), clip('b', 100, 100, 0, 1000)]
  const out = trimWithin(lane, 'a', 'right', 300 * U, newId)
  eq('a clip grown right over a neighbour takes it', out.length, 1)
  eq('and what is left is the grown one', out[0].id, 'a')
}

{
  const lane = [clip('a', 0, 100)]
  eq('trimming a clip that is not there changes nothing', trimWithin(lane, 'gone', 'right', 500 * U, newId).length, 1)
}
