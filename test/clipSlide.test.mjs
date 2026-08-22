/** The slide a row does when its pieces change places. */
import { SLIDE_MS, beginSlide, openGap, slideClips } from './.build/clipSlide.mjs'

const { eq, ok } = globalThis.__t

const c = (id, startSec, durationSec) => ({ id, startSec, durationSec, sourceOffsetSec: 0 })
const before = [c('a', 0, 1), c('b', 1, 2), c('c', 3, 3)]
const after = [c('a', 0, 1), c('c', 1, 3), c('b', 4, 2)]

eq('nothing to slide when nothing moved', beginSlide(before, before, 0), null)
eq('nor when a piece was added', beginSlide(before, [...before, c('d', 6, 1)], 0), null)
eq('nor when a piece is removed but nothing else moves', beginSlide(before, before.slice(1), 0), null)

// Closing a hole: the pieces after it come inwards, and that is the whole
// point of watching it happen.
{
  const closed = [c('a', 0, 1), c('c', 1, 3)]
  const slide = beginSlide(before, closed, 0)
  ok('losing a piece slides the rest inwards', slide !== null)
  const mid = slideClips(closed, slide, SLIDE_MS / 2)
  const moved = mid.clips.find((x) => x.id === 'c')
  ok(`and part way it is between the two — ${moved.startSec.toFixed(2)}`, moved.startSec > 1 && moved.startSec < 3)
  eq('arriving where it belongs', slideClips(closed, slide, SLIDE_MS).clips.map((x) => x.startSec).join(','), '0,1')
}
{
  // Losing the piece off the front pulls everything left.
  const shorter = [c('b', 0, 2), c('c', 2, 3)]
  ok('losing the first piece slides too', beginSlide(before, shorter, 0) !== null)
}
eq('nor when the ids are different', beginSlide(before, [c('x', 0, 1), c('b', 1, 2), c('c', 3, 3)], 0), null)
ok('a reordering does slide', beginSlide(before, after, 0) !== null)

{
  const slide = beginSlide(before, after, 1000)
  const start = slideClips(after, slide, 1000)
  eq('at the start each piece is where it was', start.clips.map((x) => x.startSec).join(','), '0,3,1')
  ok('and it has not arrived', start.done === false)

  const end = slideClips(after, slide, 1000 + SLIDE_MS)
  eq('at the end each piece is where it belongs', end.clips.map((x) => x.startSec).join(','), '0,1,4')
  ok('and it has arrived', end.done === true)

  const mid = slideClips(after, slide, 1000 + SLIDE_MS / 2)
  const c1 = mid.clips.find((x) => x.id === 'c')
  ok(`part way, a piece is between the two — ${c1.startSec.toFixed(2)}`, c1.startSec < 3 && c1.startSec > 1)
  const b1 = mid.clips.find((x) => x.id === 'b')
  ok(`and so is its neighbour — ${b1.startSec.toFixed(2)}`, b1.startSec > 1 && b1.startSec < 4)

  // Only the position moves. Lengths and audio are settled the moment the drop
  // commits; the slide is the eye catching up.
  ok('lengths never change mid-slide', mid.clips.every((x, i) => x.durationSec === after[i].durationSec))
  ok('nor the audio each piece plays', mid.clips.every((x, i) => x.sourceOffsetSec === after[i].sourceOffsetSec))
  ok('a piece that did not move is left alone', mid.clips[0] === after[0])
}
{
  // Past the end it stays put rather than overshooting.
  const slide = beginSlide(before, after, 0)
  const late = slideClips(after, slide, SLIDE_MS * 10)
  eq('long after, everything is home', late.clips.map((x) => x.startSec).join(','), '0,1,4')
  ok('and it is done', late.done === true)
}

// Room opened for a piece being held over the row.
{
  const row = [
    { id: 'a', startSec: 0, durationSec: 10, sourceOffsetSec: 0 },
    { id: 'b', startSec: 10, durationSec: 10, sourceOffsetSec: 10 },
    { id: 'c', startSec: 20, durationSec: 10, sourceOffsetSec: 20 }
  ]
  const opened = openGap(row, 1, 4)
  eq('the piece before the gap does not move', opened[0].startSec, 0)
  eq('the ones after it are pushed along by the gap', opened[1].startSec, 14)
  eq('all of them, by the same amount', opened[2].startSec, 24)
  ok('nothing is added or dropped', opened.length === 3 && opened.every((c, i) => c.id === row[i].id))
  ok('and no piece changes length', opened.every((c, i) => c.durationSec === row[i].durationSec))

  eq('room at the very end leaves the row alone', openGap(row, 3, 4), row)
  eq('so does no room at all', openGap(row, 1, 0), row)

  // It is an ordinary rearrangement as far as the slide is concerned.
  const slide = beginSlide(row, openGap(row, 1, 4), 0)
  ok('opening it slides', slide !== null)
  const half = slideClips(openGap(row, 1, 4), slide, SLIDE_MS / 2)
  ok(`part way, the gap is part open — ${half.clips[1].startSec.toFixed(1)}s`,
    half.clips[1].startSec > 10 && half.clips[1].startSec < 14)
}
