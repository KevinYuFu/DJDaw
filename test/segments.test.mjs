/**
 * A row as an ordered list of segments: reordering trades places, and deleting
 * from the middle leaves a hole that can be deleted again.
 */
import {
  deleteSegment,
  dropIndex,
  layOut,
  reorderClip,
  segmentIndexAt,
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
