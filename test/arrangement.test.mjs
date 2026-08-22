/**
 * Dragging a clip's edges.
 *
 * A clip is a window onto its file, so pulling an edge outward gives back
 * audio an earlier drag trimmed off, and pulling it inward hides audio rather
 * than losing it. Neither edge can go past the file, and neither can run into
 * the clip next door.
 */
import {
  MIN_CLIP_SEC,
  clipAt,
  dragEndEdge,
  dragStartEdge,
  endEdgeRange,
  fits,
  moveClip,
  moveTrack,
  selectAfterRemoving,
  startEdgeRange,
  trackDuration,
  voiceRegions
} from './.build/arrangement.mjs'

const { eq, ok } = globalThis.__t

/** A 10s clip at 20s, taken from the middle of a 60s file. */
const clip = (over = {}) => ({
  id: 'c',
  startSec: 20,
  durationSec: 10,
  sourceOffsetSec: 15,
  sourceId: 'file',
  sourceDurationSec: 60,
  ...over
})
const only = (over) => [clip(over)]
const of = (row, id = 'c') => row.find((c) => c.id === id)

// --- the right edge ------------------------------------------------------
{
  const row = only()
  const out = of(dragEndEdge(row, 'c', 36))
  eq('dragging it out makes the clip longer', out.durationSec, 16)
  eq('it still starts where it did', out.startSec, 20)
  eq('and reads from the same place in the file', out.sourceOffsetSec, 15)

  const shorter = of(dragEndEdge(row, 'c', 25))
  eq('dragging it in makes the clip shorter', shorter.durationSec, 5)
  eq('and nothing about the front moves', shorter.sourceOffsetSec, 15)

  // 15s in, 45s of file left, so the clip cannot pass 65s on the timeline.
  const past = of(dragEndEdge(row, 'c', 200))
  eq('it stops at the end of the file', past.durationSec, 45)
  eq('and the range says so', endEdgeRange(row, clip())[1], 65)

  const tiny = of(dragEndEdge(row, 'c', 5))
  eq('and it cannot be dragged away to nothing', tiny.durationSec, MIN_CLIP_SEC)
}

// --- the left edge -------------------------------------------------------
{
  const row = only()
  const out = of(dragStartEdge(row, 'c', 10))
  eq('dragging it out starts the clip earlier', out.startSec, 10)
  eq('the clip is longer by the same amount', out.durationSec, 20)
  eq('and it now plays from earlier in the file', out.sourceOffsetSec, 5)
  eq('the end has not moved', out.startSec + out.durationSec, 30)

  const inward = of(dragStartEdge(row, 'c', 26))
  eq('dragging it in starts the clip later', inward.startSec, 26)
  eq('shorter by the same amount', inward.durationSec, 4)
  eq('reading from further into the file', inward.sourceOffsetSec, 21)

  // Only 15s of file in front of it, so it cannot start before 5s.
  const past = of(dragStartEdge(row, 'c', 0))
  eq('it stops where the file starts', past.startSec, 5)
  eq('with the file read from its very beginning', past.sourceOffsetSec, 0)
  eq('and the range says so', startEdgeRange(row, clip())[0], 5)
}

// --- the file cannot be revealed past the front of the timeline ----------
{
  // 30s of file in front, but the clip only starts at 4s.
  const row = only({ startSec: 4, sourceOffsetSec: 30 })
  eq('it stops at the start of the timeline', of(dragStartEdge(row, 'c', -50)).startSec, 0)
  eq('and gives back only the audio there was room for',
    of(dragStartEdge(row, 'c', -50)).sourceOffsetSec, 26)
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

  // A gap either side is room to grow into, and that is all.
  eq('the range in front is the gap', startEdgeRange(row, clip())[0], 12)
  eq('the range behind is the gap', endEdgeRange(row, clip())[1], 34)
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

// --- the stack of tracks -------------------------------------------------
{
  const ids = ['t1', 't2', 't3']
  eq('a track moves up the stack', moveTrack(ids, 't3', -1).join(','), 't1,t3,t2')
  eq('and down it', moveTrack(ids, 't1', 1).join(','), 't2,t1,t3')
  eq('the top one has nowhere further up', moveTrack(ids, 't1', -1).join(','), 't1,t2,t3')
  eq('nor the bottom one down', moveTrack(ids, 't3', 1).join(','), 't1,t2,t3')
  eq('a track that is not there changes nothing', moveTrack(ids, 'x', 1).join(','), 't1,t2,t3')

  eq('deleting one selects the one that takes its place', selectAfterRemoving(ids, 't2'), 't3')
  eq('deleting the last selects the one before it', selectAfterRemoving(ids, 't3'), 't2')
  eq('and deleting the only one selects nothing', selectAfterRemoving(['t1'], 't1'), null)
}

// --- moving a clip along its track ---------------------------------------
{
  const a = { ...clip(), id: 'a', startSec: 0, durationSec: 8 }
  const b = clip()
  const c = { ...clip(), id: 'c2', startSec: 40, durationSec: 8 }
  const row = [a, b, c]
  eq('it goes where it is put', of(moveClip(row, 'c', 12), 'c').startSec, 12)
  eq('it stops flush against the clip in front', of(moveClip(row, 'c', 0), 'c').startSec, 8)
  eq('and flush against the one behind', of(moveClip(row, 'c', 100), 'c').startSec, 30)
  eq('the neighbours never move', of(moveClip(row, 'c', 0), 'a').startSec, 0)
  eq('and it never goes before the start of time', of(moveClip([clip()], 'c', -20), 'c').startSec, 0)
}

// --- what one file plays on one track ------------------------------------
{
  const mine = { ...clip(), id: 'm', startSec: 10, durationSec: 5, sourceOffsetSec: 2 }
  const theirs = { ...clip(), id: 't', startSec: 20, durationSec: 5, sourceId: 'other' }
  const regions = voiceRegions([mine, theirs], 'file', 60)
  eq('only its own clips play', regions[0].sourceOffsetSec, 2)
  eq('starting where the clip does', regions[0].startSec, 10)
  eq('a tail reaches the end of the arrangement', regions[1].startSec + regions[1].durationSec, 60)
  ok(`and the tail reads past the end of the file, which is silence — ${regions[1].sourceOffsetSec}`,
    regions[1].sourceOffsetSec > mine.sourceDurationSec)
  eq('a track that already fills the timeline gets no tail',
    voiceRegions([{ ...clip(), startSec: 0, durationSec: 60 }], 'file', 60).length, 1)
  eq('a file with nothing on the track is silence all through',
    voiceRegions([theirs], 'file', 60).length, 1)
}
