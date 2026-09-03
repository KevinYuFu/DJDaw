/**
 * What a session starts as.
 *
 * A cleared session and a freshly opened one have to be the same thing, so
 * these check the shape the arrangement builds from rather than the clearing
 * itself: eight named lanes, nothing on any of them, every knob centred.
 */
import { DEFAULT_MASTER_BPM, LANE_NAMES, freshLanes, laneId } from './.build/session.mjs'

const { eq, ok } = globalThis.__t

// ---------------------------------------------------------------- lane ids

eq('the first lane counts from one', laneId(0), 'lane-1')
eq('the eighth lane is the eighth', laneId(7), 'lane-8')

// -------------------------------------------------------------- fresh lanes

const lanes = freshLanes()

eq('a session opens with one lane per name', lanes.length, LANE_NAMES.length)
eq('eight of them', lanes.length, 8)

const ids = new Set(lanes.map((lane) => lane.id))
eq('every lane has its own id', ids.size, lanes.length)

lanes.forEach((lane, i) => {
  eq(`lane ${i + 1} is named for its letter`, lane.name, LANE_NAMES[i])
  eq(`lane ${i + 1} carries the matching id`, lane.id, laneId(i))
  eq(`lane ${i + 1} has nothing on it`, lane.clips.length, 0)
  ok(`lane ${i + 1} is not muted`, lane.muted === false)
  ok(`lane ${i + 1} is not soloed`, lane.soloed === false)
  eq(`lane ${i + 1} is at full volume`, lane.volume, 1)
  eq(`lane ${i + 1} is centred`, lane.pan, 0)
})

// Clearing hands back a session, not the same one: a lane emptied by hand must
// not reach back into the lanes the next session gets.
const again = freshLanes()
ok('each call builds its own lanes', again !== lanes && again[0] !== lanes[0])
again[0].clips.push('something')
eq('so filling one leaves the next alone', freshLanes()[0].clips.length, 0)

// ------------------------------------------------------------------- tempo

ok('the opening tempo is a usable one', DEFAULT_MASTER_BPM >= 20 && DEFAULT_MASTER_BPM <= 300)
eq('and it is 120', DEFAULT_MASTER_BPM, 120)
