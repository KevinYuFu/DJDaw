/**
 * A row as an ordered list of segments: reordering trades places rather than
 * overwriting, and deleting from the middle leaves a hole you can delete again.
 */
import {
  deleteSegment,
  dropIndex,
  fillHole,
  fillStartSec,
  layOut,
  reorderClip,
  sourceIdsOf,
  splitAt,
  segmentIndexAt,
  timelineDuration,
  toRegions
} from './.build/clips.mjs'

const { eq, ok } = globalThis.__t

/** A, B, C, D of 1, 2, 3, 4 seconds. */
const row = () =>
  layOut([
    { id: 'A', startSec: 0, durationSec: 1, sourceOffsetSec: 0 },
    { id: 'B', startSec: 0, durationSec: 2, sourceOffsetSec: 10 },
    { id: 'C', startSec: 0, durationSec: 3, sourceOffsetSec: 20 },
    { id: 'D', startSec: 0, durationSec: 4, sourceOffsetSec: 30 }
  ])
const order = (clips) => clips.map((c) => c.id).join('')
const starts = (clips) => clips.map((c) => c.startSec).join(',')

eq('pieces lie end to end', starts(row()), '0,1,3,6')
eq('and keep their order', order(row()), 'ABCD')

// Reordering
eq('B past C trades places', order(reorderClip(row(), 'B', 2)), 'ACBD')
eq('and everything still lies end to end', starts(reorderClip(row(), 'B', 2)), '0,1,4,6')
eq('the row is the same length after', 
  starts(reorderClip(row(), 'B', 2)).split(',').length, 4)
eq('a piece can go to the front', order(reorderClip(row(), 'D', 0)), 'DABC')
eq('and to the back', order(reorderClip(row(), 'A', 3)), 'BCDA')
eq('dropping it where it is changes nothing', order(reorderClip(row(), 'B', 1)), 'ABCD')
eq('an unknown id changes nothing', order(reorderClip(row(), 'Z', 0)), 'ABCD')

// Nothing is ever trimmed: every piece keeps its own audio and its length.
{
  const moved = reorderClip(row(), 'B', 2)
  const b = moved.find((c) => c.id === 'B')
  eq('a moved piece keeps its length', b.durationSec, 2)
  eq('and the audio it plays', b.sourceOffsetSec, 10)
  const total = moved.reduce((n, c) => n + c.durationSec, 0)
  eq('and the row keeps its length', total, 10)
}

// Where a drop lands
eq('dropped at the very start it goes first', dropIndex(row(), 'B', 0), 0)
eq('dragged just past half of C it trades with C', dropIndex(row(), 'B', 2.6), 2)
eq('and short of half of C it stays put', dropIndex(row(), 'B', 2.4), 1)
eq('dropped past the end it goes last', dropIndex(row(), 'B', 99), 3)

// Deleting
{
  const { clips, selectId } = deleteSegment(row(), 'B')
  eq('deleting from the middle leaves the order', order(clips), 'ABCD'.replace('B', clips[1].id))
  ok('the second piece is now a hole', clips[1].silent === true)
  eq('the hole is the same length', clips[1].durationSec, 2)
  eq('and it is handed back to be selected', selectId, clips[1].id)
  eq('the row is the same length', clips.reduce((n, c) => n + c.durationSec, 0), 10)

  const again = deleteSegment(clips, selectId)
  eq('deleting the hole closes the row up', order(again.clips), 'ACD')
  eq('and shortens it', again.clips.reduce((n, c) => n + c.durationSec, 0), 8)
  eq('with nothing left selected', again.selectId, null)
}
{
  const { clips, selectId } = deleteSegment(row(), 'A')
  eq('deleting the first piece just shortens the row', order(clips), 'BCD')
  eq('leaving no hole to select', selectId, null)
  eq('and the rest start at zero', clips[0].startSec, 0)
}
{
  const { clips, selectId } = deleteSegment(row(), 'D')
  eq('deleting the last piece just shortens the row', order(clips), 'ABC')
  eq('leaving no hole to select', selectId, null)
}

// A hole plays nothing, and can be reordered like anything else.
{
  const { clips } = deleteSegment(row(), 'B')
  const regions = toRegions(clips)
  eq('a hole is not played', regions.length, 3)
  ok('and the pieces around it are', regions.every((r) => r.durationSec > 0))
  const moved = reorderClip(clips, clips[1].id, 3)
  ok('a hole can be dragged elsewhere', moved[3].silent === true)
  eq('and the row still lies end to end', starts(moved), '0,1,4,8')
}

eq('a time inside the second piece finds it', segmentIndexAt(row(), 1.5), 1)
eq('a time past the end finds nothing', segmentIndexAt(row(), 99), -1)

// A switched-off piece keeps its place and plays nothing.
{
  const clips = layOut([
    { id: 'a', startSec: 0, durationSec: 10, sourceOffsetSec: 0 },
    { id: 'b', startSec: 0, durationSec: 10, sourceOffsetSec: 10, disabled: true },
    { id: 'c', startSec: 0, durationSec: 10, sourceOffsetSec: 20 }
  ])
  const regions = toRegions(clips)
  ok(`it is not handed to the engine — ${regions.length} regions`, regions.length === 2)
  ok('the pieces either side keep their own audio',
    regions[0].sourceOffsetSec === 0 && regions[1].sourceOffsetSec === 20)
  ok(`and it still takes up its time — ${regions[1].startSec}s`, regions[1].startSec === 20)
  ok(`the row is still as long as it was — ${timelineDuration(clips)}s`, timelineDuration(clips) === 30)
}

// Dropping a piece into a hole: it lands where it was let go and the hole is
// cut around it, so the row stays exactly as long as it was.
{
  const row = () => layOut([
    { id: 'a', startSec: 0, durationSec: 10, sourceOffsetSec: 0 },
    { id: 'hole', startSec: 0, durationSec: 40, sourceOffsetSec: 0, silent: true },
    { id: 'b', startSec: 0, durationSec: 10, sourceOffsetSec: 50 }
  ])
  const piece = { id: 'x', startSec: 0, durationSec: 12, sourceOffsetSec: 4, sourceId: 'other' }
  const len = (cs) => cs.reduce((a, c) => a + c.durationSec, 0)

  {
    // Let go 15s into the hole.
    const out = fillHole(row(), 'hole', 25, piece)
    const at = out.find((c) => c.id === 'x')
    eq('it starts where it was let go', at.startSec, 25)
    eq('the row is exactly as long as it was', len(out), 60)
    ok(`the hole was cut either side of it — ${JSON.stringify(out.map((c) => [c.id === 'x' ? 'x' : c.silent ? 'hole' : c.id, c.durationSec]))}`,
      out.length === 5 && out[1].silent && out[1].durationSec === 15 && out[3].silent && out[3].durationSec === 13)
    ok('and it keeps its own audio', at.sourceId === 'other' && at.sourceOffsetSec === 4)
  }
  {
    // Let go right at the front of the hole.
    const out = fillHole(row(), 'hole', 10, piece)
    eq('at the front, no hole is left in front of it', out[1].id, 'x')
    eq('and the rest of the hole follows it', out[2].durationSec, 28)
    eq('the row is still the same length', len(out), 60)
  }
  {
    // Close enough to the front that a sliver would be left.
    const out = fillHole(row(), 'hole', 10.005, piece)
    eq('a sliver in front is closed up instead', out[1].id, 'x')
    eq('and the row is still the same length', len(out), 60)
  }
  {
    // Past the point where it still fits.
    const out = fillHole(row(), 'hole', 500, piece)
    const at = out.find((c) => c.id === 'x')
    eq('past the end it is pushed flush to the back', at.startSec + at.durationSec, 50)
    eq('with the hole all in front of it', out[1].durationSec, 28)
  }
  {
    const exact = { ...piece, durationSec: 40 }
    const out = fillHole(row(), 'hole', 20, exact)
    ok(`a piece that exactly fills it leaves no hole — ${out.length} pieces`, out.length === 3)
    eq('and the row is unchanged in length', len(out), 60)
  }
  eq('a piece longer than the hole does not fit',
    fillHole(row(), 'hole', 10, { ...piece, durationSec: 41 }), null)
  eq('and neither does a piece dropped on something that is not a hole',
    fillHole(row(), 'a', 5, piece), null)

  // Where the drop line goes is the same answer.
  const hole = row()[1]
  eq('the line sits where the piece will start', fillStartSec(hole, 25, 12), 25)
  eq('flush to the front when it is close enough', fillStartSec(hole, 10.005, 12), 10)
  eq('and flush to the back past the end', fillStartSec(hole, 500, 12), 38)
}

// A cut makes two of the same piece, so both halves keep what it was.
{
  const row = layOut([
    { id: 'a', startSec: 0, durationSec: 10, sourceOffsetSec: 0 },
    { id: 'b', startSec: 0, durationSec: 20, sourceOffsetSec: 5, sourceId: 'other', disabled: true }
  ])
  const { left, right } = splitAt(row, 20)
  ok(`both halves play the file the piece played — ${left.sourceId} / ${right.sourceId}`,
    left.sourceId === 'other' && right.sourceId === 'other')
  ok('and both are still switched off', left.disabled === true && right.disabled === true)
  eq('the right half reads on from where the left stops', right.sourceOffsetSec, 15)
  eq('and it is a different piece', right.id === left.id, false)

  const holes = splitAt(layOut([{ id: 'h', startSec: 0, durationSec: 20, sourceOffsetSec: 0, silent: true }]), 10)
  ok('cutting a hole gives two holes', holes.left.silent === true && holes.right.silent === true)
}

// Every file a row has a piece for, whether or not that piece plays.
{
  const row = layOut([
    { id: 'a', startSec: 0, durationSec: 10, sourceOffsetSec: 0, sourceId: 'own' },
    { id: 'b', startSec: 0, durationSec: 10, sourceOffsetSec: 0, sourceId: 'guest', disabled: true },
    { id: 'h', startSec: 0, durationSec: 10, sourceOffsetSec: 0, silent: true },
    { id: 'c', startSec: 0, durationSec: 10, sourceOffsetSec: 0, sourceId: 'own' }
  ])
  eq('a switched-off piece still counts, a hole does not',
    sourceIdsOf(row).join(','), 'own,guest')
  eq('and the engine is only given what plays', toRegions(row).length, 2)
}
