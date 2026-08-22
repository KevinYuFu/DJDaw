/**
 * Clips on an arrangement timeline.
 *
 * Every clip plays at whatever speed makes its own grid match the
 * arrangement's, so timeline seconds and file seconds are not the same thing:
 * a 174 file on a 150 arrangement reads 1.16 seconds of itself for every
 * second of the timeline.
 */
import {
  MIN_CLIP_SEC,
  clipAt,
  dragEndEdge,
  dragStartEdge,
  endEdgeRange,
  fits,
  moveClip,
  moveTrackTo,
  rateFor,
  selectAfterRemoving,
  startEdgeRange,
  toTimelineSec,
  trackDuration,
  voiceRegions
} from './.build/arrangement.mjs'

const { eq, ok } = globalThis.__t

/** A 10s clip at 20s, from the middle of a 60s file, playing at its own speed. */
const clip = (over = {}) => ({
  id: 'c',
  startSec: 20,
  durationSec: 10,
  sourceOffsetSec: 15,
  sourceId: 'file',
  sourceDurationSec: 60,
  rate: 1,
  ...over
})
const only = (over) => [clip(over)]
const of = (row, id = 'c') => row.find((c) => c.id === id)

// --- the speed a file has to play at ------------------------------------
{
  eq('a 174 file on a 150 arrangement plays fast', +rateFor(174, 150).toFixed(4), 1.16)
  eq('a 128 file on a 150 arrangement plays slow', +rateFor(128, 150).toFixed(4), 0.8533)
  eq('the same tempo plays untouched', rateFor(150, 150), 1)
  eq('an unknown tempo is left alone', rateFor(0, 150), 1)
  eq('a minute of a 1.16 file is under a minute of timeline',
    +toTimelineSec(60, 1.16).toFixed(2), 51.72)
}

// --- the right edge ------------------------------------------------------
{
  const row = only()
  eq('dragging it out makes the clip longer', of(dragEndEdge(row, 'c', 36)).durationSec, 16)
  eq('it still starts where it did', of(dragEndEdge(row, 'c', 36)).startSec, 20)
  eq('reading from the same place in the file', of(dragEndEdge(row, 'c', 36)).sourceOffsetSec, 15)
  eq('dragging it in makes the clip shorter', of(dragEndEdge(row, 'c', 25)).durationSec, 5)
  // 15s in, 45s of file left, so at 1x the clip cannot pass 65s.
  eq('it stops at the end of the file', of(dragEndEdge(row, 'c', 200)).durationSec, 45)
  eq('and the range says so', endEdgeRange(row, clip())[1], 65)
  eq('it cannot be dragged away to nothing', of(dragEndEdge(row, 'c', 5)).durationSec, MIN_CLIP_SEC)

  // Playing at 2x, the same 45s of file is only 22.5s of timeline.
  const fast = only({ rate: 2 })
  eq('a clip playing fast runs out sooner', of(dragEndEdge(fast, 'c', 200)).durationSec, 22.5)
}

// --- the left edge -------------------------------------------------------
{
  const row = only()
  const out = of(dragStartEdge(row, 'c', 10))
  eq('dragging it out starts the clip earlier', out.startSec, 10)
  eq('longer by the same amount', out.durationSec, 20)
  eq('and it plays from earlier in the file', out.sourceOffsetSec, 5)
  eq('the end has not moved', out.startSec + out.durationSec, 30)

  const inward = of(dragStartEdge(row, 'c', 26))
  eq('dragging it in starts the clip later', inward.startSec, 26)
  eq('shorter by the same amount', inward.durationSec, 4)
  eq('reading from further into the file', inward.sourceOffsetSec, 21)

  // 15s of file in front, so at 1x it cannot start before 5s.
  eq('it stops where the file starts', of(dragStartEdge(row, 'c', 0)).startSec, 5)
  eq('with the file read from its very beginning', of(dragStartEdge(row, 'c', 0)).sourceOffsetSec, 0)
  eq('and the range says so', startEdgeRange(row, clip())[0], 5)

  // At 2x that 15s of file is only 7.5s of timeline.
  const fast = only({ rate: 2 })
  eq('a clip playing fast has less room in front', startEdgeRange(fast, clip({ rate: 2 }))[0], 12.5)
  eq('and still lands on the start of the file',
    of(dragStartEdge(fast, 'c', 0)).sourceOffsetSec, 0)
}

// --- neighbours ----------------------------------------------------------
{
  const before = { ...clip(), id: 'before', startSec: 8, durationSec: 4, sourceOffsetSec: 0 }
  const after = { ...clip(), id: 'after', startSec: 34, durationSec: 4, sourceOffsetSec: 0 }
  const row = [before, clip(), after]
  eq('the left edge stops at the clip in front of it', of(dragStartEdge(row, 'c', 0)).startSec, 12)
  const right = of(dragEndEdge(row, 'c', 100))
  eq('the right edge stops at the clip after it', right.startSec + right.durationSec, 34)
  eq('the neighbours are left alone', of(dragEndEdge(row, 'c', 100), 'after').startSec, 34)

  eq('it goes where it is put', of(moveClip(row, 'c', 14)).startSec, 14)
  eq('stopping flush against the one in front', of(moveClip(row, 'c', 0)).startSec, 12)
  eq('and flush against the one behind', of(moveClip(row, 'c', 100)).startSec, 24)
  eq('never before the start of time', of(moveClip(only(), 'c', -20)).startSec, 0)
}

// --- the timeline --------------------------------------------------------
{
  const row = [clip(), { ...clip(), id: 'd', startSec: 40, durationSec: 5 }]
  eq('a track runs to the end of its last clip', trackDuration(row), 45)
  eq('the silence between clips belongs to nothing', clipAt(row, 35), null)
  eq('and a moment inside one finds it', clipAt(row, 22).id, 'c')
  ok('a clip fits where nothing else is', fits(row, 'new', 31, 8))
  ok('but not over one that is there', !fits(row, 'new', 25, 8))
  ok('and never before the start of time', !fits(row, 'new', -1, 2))
}

// --- what the engine is told ---------------------------------------------
{
  const mine = clip({ id: 'm', startSec: 10, durationSec: 5, sourceOffsetSec: 2 })
  const theirs = clip({ id: 't', startSec: 20, sourceId: 'other' })
  const at1 = voiceRegions([mine, theirs], 'file', 60, 1)
  eq('only its own clips play', at1[0].sourceOffsetSec, 2)
  eq('starting where the clip does', at1[0].startSec, 10)
  eq('a tail reaches the end of the arrangement', at1[1].startSec + at1[1].durationSec, 60)
  ok(`the tail reads past the end of the file, which is silence — ${at1[1].sourceOffsetSec}`,
    at1[1].sourceOffsetSec > mine.sourceDurationSec)

  // The engine walks its timeline at the voice's rate, so every time is scaled
  // by it — that is what makes the clip read its file faster while staying put.
  const at2 = voiceRegions([mine], 'file', 60, 2)
  eq('a voice playing fast is given a stretched timeline', at2[0].startSec, 20)
  eq('stretched by the same amount', at2[0].durationSec, 10)
  eq('but it reads the file from the same place', at2[0].sourceOffsetSec, 2)
  eq('and its tail reaches the scaled end', at2[1].startSec + at2[1].durationSec, 120)

  eq('a track that already fills the timeline gets no tail',
    voiceRegions([clip({ startSec: 0, durationSec: 60 })], 'file', 60, 1).length, 1)
  eq('a file with nothing on the track is silence all through',
    voiceRegions([theirs], 'file', 60, 1).length, 1)
}

// --- the stack of tracks -------------------------------------------------
{
  const ids = ['t1', 't2', 't3']
  eq('a track goes where it is dropped', moveTrackTo(ids, 't3', 0).join(','), 't3,t1,t2')
  eq('and to the end', moveTrackTo(ids, 't1', 2).join(','), 't2,t3,t1')
  eq('one that is not there changes nothing', moveTrackTo(ids, 'x', 1).join(','), 't1,t2,t3')
  eq('deleting one selects the one that takes its place', selectAfterRemoving(ids, 't2'), 't3')
  eq('deleting the last selects the one before it', selectAfterRemoving(ids, 't3'), 't2')
  eq('and deleting the only one selects nothing', selectAfterRemoving(['t1'], 't1'), null)
}
