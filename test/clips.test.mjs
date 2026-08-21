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
