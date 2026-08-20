/**
 * Clip maths for the editing view.
 *
 * The thing that actually matters here is that timeline position and source
 * position stay correctly related after a cut. Get that wrong and the waveform
 * draws one thing while the audio plays another.
 */
import * as C from './.build/clips.mjs'

const { eq, ok } = globalThis.__t

const whole = () => [C.wholeTrackClip(200)]

eq('a fresh track is one clip', whole().length, 1)
eq('starting at zero', whole()[0].startSec, 0)
eq('covering the whole file', whole()[0].durationSec, 200)
eq('from the start of the source', whole()[0].sourceOffsetSec, 0)
eq('timeline length is the clip length', C.timelineDuration(whole()), 200)

// A cut at 60s makes 0-60 and 60-200.
{
  const r = C.splitAt(whole(), 60)
  eq('a cut makes two clips', r.clips.length, 2)
  eq('the left piece keeps the start', r.clips[0].startSec, 0)
  eq('and runs to the cut', r.clips[0].durationSec, 60)
  eq('the right piece starts at the cut', r.clips[1].startSec, 60)
  eq('and covers the rest', r.clips[1].durationSec, 140)
  eq('the right piece reads from 60s into the file', r.clips[1].sourceOffsetSec, 60)
  eq('the timeline is unchanged in length', C.timelineDuration(r.clips), 200)
  ok('the two pieces have different ids', r.clips[0].id !== r.clips[1].id)
}

// Cutting twice gives three pieces, each pointing at the right source audio.
{
  const once = C.splitAt(whole(), 60).clips
  const twice = C.splitAt(once, 120).clips
  eq('three pieces', twice.length, 3)
  eq('middle piece starts at 60 on the timeline', twice[1].startSec, 60)
  eq('and at 60 in the source', twice[1].sourceOffsetSec, 60)
  eq('last piece starts at 120 on the timeline', twice[2].startSec, 120)
  eq('and at 120 in the source', twice[2].sourceOffsetSec, 120)
}

// Refusals: a cut must not make a sliver you cannot grab.
{
  const onBoundary = C.splitAt(whole(), 0)
  eq('a cut at the very start does nothing', onBoundary.clips.length, 1)
  eq('and says why', onBoundary.reason, 'too-short')

  const past = C.splitAt(whole(), 500)
  eq('a cut past the end does nothing', past.clips.length, 1)
  eq('and says it fell in a gap', past.reason, 'gap')

  const sliver = C.splitAt(whole(), 199.999)
  eq('a cut that would leave a sliver does nothing', sliver.clips.length, 1)
  eq('and says why', sliver.reason, 'too-short')
}

// Deleting leaves a gap; the gap reads as silence.
{
  const three = C.splitAt(C.splitAt(whole(), 60).clips, 120).clips
  const gapped = C.removeClip(three, three[1].id)
  eq('the clip is gone', gapped.length, 2)
  eq('and the ones after it have not moved', gapped[1].startSec, 120)
  eq('the hole reads as a gap', C.clipAt(gapped, 90), null)
  eq('and has no source position', C.sourceTimeAt(gapped, 90), null)
  eq('the timeline keeps its length', C.timelineDuration(gapped), 200)
}

// Ripple delete closes the gap instead.
{
  const three = C.splitAt(C.splitAt(whole(), 60).clips, 120).clips
  const rippled = C.rippleRemoveClip(three, three[1].id)
  eq('the clip is gone', rippled.length, 2)
  eq('and the one after moved back by its length', rippled[1].startSec, 60)
  eq('so the timeline got shorter', C.timelineDuration(rippled), 140)
  eq('and there is no gap', C.clipAt(rippled, 90) !== null, true)
}

// The conversion everything else depends on.
{
  const three = C.splitAt(C.splitAt(whole(), 60).clips, 120).clips
  eq('inside the first piece, timeline equals source', C.sourceTimeAt(three, 30), 30)
  eq('inside the second piece too, since nothing moved', C.sourceTimeAt(three, 90), 90)

  // Move the last piece into a gap left by deleting the middle one. Now the
  // two clocks genuinely differ, which is the whole point of the model.
  const gapped = C.removeClip(three, three[1].id)
  const moved = C.moveClip(gapped, three[2].id, 70)
  const src = C.sourceTimeAt(moved, 75)
  eq('a moved piece reads from its own source offset', src, 125)
  ok('which is not the timeline position', src !== 75)

  // Overlaps are not a supported edit, but must stay deterministic.
  const overlapped = C.moveClip(three, three[2].id, 20)
  eq('where clips overlap, the earlier one wins', C.sourceTimeAt(overlapped, 25), 25)
}

{
  const moved = C.moveClip(whole(), C.wholeTrackClip(10).id, 5)
  eq('moving an unknown clip changes nothing', moved.length, 1)
  eq('a clip cannot be moved before zero', C.moveClip(whole(), whole()[0].id, -50)[0].startSec, 0)
}

// Regions handed to the audio engine.
{
  const three = C.splitAt(C.splitAt(whole(), 60).clips, 120).clips
  const gapped = C.removeClip(three, three[1].id)
  const regions = C.toRegions(gapped)
  eq('a gap becomes two regions, not three', regions.length, 2)
  eq('first region starts at zero', regions[0].startSec, 0)
  eq('second region starts after the gap', regions[1].startSec, 120)
  eq('and reads from the right place in the file', regions[1].sourceOffsetSec, 120)
  ok('regions come out in timeline order',
    regions.every((r, i) => i === 0 || r.startSec >= regions[i - 1].startSec))
}

eq('an empty timeline has no length', C.timelineDuration([]), 0)
eq('and nothing plays', C.toRegions([]).length, 0)
eq('nothing is under the playhead', C.clipAt([], 5), null)

// Clips arriving out of order must still behave.
{
  const jumbled = [
    { id: 'b', startSec: 100, durationSec: 50, sourceOffsetSec: 100 },
    { id: 'a', startSec: 0, durationSec: 100, sourceOffsetSec: 0 }
  ]
  eq('sorting puts them in timeline order', C.sortClips(jumbled)[0].id, 'a')
  eq('regions come out sorted regardless', C.toRegions(jumbled)[0].startSec, 0)
  eq('and lookups still work', C.clipAt(jumbled, 120).id, 'b')
}

// ---------------------------------------------------------------------------
// placeClip: dragging one clip on top of another
// ---------------------------------------------------------------------------

// A three-piece timeline: 0-60, 60-120, 120-200.
const three = () => C.splitAt(C.splitAt(whole(), 60).clips, 120).clips

{
  const t = three()
  const moved = C.placeClip(t, t[2].id, 300)
  eq('dropping a clip in empty space leaves the others alone', moved.length, 3)
  eq('and it lands where asked', moved[2].startSec, 300)
  eq('carrying its own audio with it', moved[2].sourceOffsetSec, 120)
}

{
  // Drop the last piece exactly over the middle one.
  const t = three()
  const moved = C.placeClip(t, t[2].id, 60)
  eq('a fully covered clip is removed', moved.length, 2)
  eq('the first piece survives', moved[0].startSec, 0)
  eq('the dropped one is where it was put', moved[1].startSec, 60)
  eq('and still reads its own audio', moved[1].sourceOffsetSec, 120)
}

{
  // Drop the last piece so its left edge lands inside a neighbour: that
  // neighbour keeps its start and is shortened to meet it.
  const t = C.splitAt(three(), 30).clips   // 0-30, 30-60, 60-120, 120-200
  const moved = C.placeClip(t, t[t.length - 1].id, 40)
  const abutting = moved.find((c) => c.startSec === 30)
  eq('the clip it landed on keeps its start', abutting.startSec, 30)
  eq('and is shortened to meet the dropped one', C.clipEnd(abutting), 40)
  eq('a clip it fully covered is gone', moved.some((c) => c.startSec === 60), false)
  eq('and one entirely clear of it is untouched', moved.find((c) => c.startSec === 0).durationSec, 30)
  ok('nothing overlaps afterwards',
    moved.every((c, i) => i === 0 || c.startSec >= C.clipEnd(moved[i - 1]) - 1e-9))
}

{
  // Straddle: drop a short piece into the middle of a long one.
  const long = [C.wholeTrackClip(200)]
  const cut = C.splitAt(long, 150).clips          // 0-150, 150-200
  const moved = C.placeClip(cut, cut[1].id, 50)   // 50-100 lands inside 0-150
  eq('the straddled clip becomes two pieces', moved.length, 3)
  eq('the left end keeps the original start', moved[0].startSec, 0)
  eq('and stops where the dropped one starts', C.clipEnd(moved[0]), 50)
  eq('the dropped clip sits in the middle', moved[1].startSec, 50)
  eq('the right end resumes after it', moved[2].startSec, 100)
  eq('and its source offset moved with it, so the audio does not slide',
    moved[2].sourceOffsetSec, 100)
}

{
  // Clipped on the left: the survivor's source offset must move by the same
  // amount it was trimmed, or the audio inside slides.
  const cut = C.splitAt([C.wholeTrackClip(200)], 100).clips  // 0-100, 100-200
  const moved = C.placeClip(cut, cut[0].id, 60)              // 60-160 over 100-200
  const right = moved.find((c) => c.startSec === 160)
  ok('the right-hand clip survives, trimmed', right != null)
  eq('trimmed by 60 seconds', right.durationSec, 40)
  eq('and its source offset moved by the same 60', right.sourceOffsetSec, 160)
  eq('so timeline 170s still reads source 170s', C.sourceTimeAt(moved, 170), 170)
}

{
  const t = three()
  const moved = C.placeClip(t, t[0].id, -40)
  eq('a clip cannot be dragged before zero', moved[0].startSec, 0)
}

{
  const t = three()
  eq('placing an unknown clip changes nothing', C.placeClip(t, 'nope', 10).length, 3)
}

{
  // The invariant that matters: after any drop, nothing overlaps.
  let t = three()
  const ids = t.map((c) => c.id)
  for (const [i, at] of [[0, 90], [2, 15], [1, 150], [0, 0]]) {
    t = C.placeClip(t, ids[i] ?? t[0].id, at)
    ok(`no overlaps after dropping at ${at}`,
      t.every((c, n) => n === 0 || c.startSec >= C.clipEnd(t[n - 1]) - 1e-9))
  }
}
