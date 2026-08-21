/**
 * Navigating between markers.
 *
 * The awkward bit is landing exactly on a point: jumping right from a marker
 * has to reach the next one, not sit still, or the key feels dead.
 */
import * as P from './.build/pointsOfInterest.mjs'

const { eq, ok } = globalThis.__t

const track = {
  cuePoint: 10,
  hotCues: [
    { index: 0, time: 30, color: '#fff', type: 'cue' },
    { index: 2, time: 50, color: '#fff', type: 'cue', name: 'Drop' }
  ],
  memoryCues: [{ time: 20 }, { time: 40, name: 'Break' }]
}

const points = P.pointsOfInterest(track)

eq('every marker becomes a point', points.length, 5)
eq('they come out in time order', points.map((p) => p.time).join(','), '10,20,30,40,50')
eq('the CUE point is included', points[0].kind, 'cue')
eq('a memory cue is a locator', points[1].kind, 'memory')
eq('a hot cue keeps its pad letter', points[2].label, 'A')
eq('a named hot cue uses its name', points[4].label, 'Drop')
eq('a named locator uses its name', points[3].label, 'Break')
eq('an unnamed locator gets a number', points[1].label, '1')

// Walking right.
eq('from the start, right lands on the first point', P.nextPoint(points, 0).time, 10)
eq('from between points, right lands on the next', P.nextPoint(points, 25).time, 30)
eq('from exactly on a point, right moves past it', P.nextPoint(points, 30).time, 40)
eq('and from a hair before it, still lands on it', P.nextPoint(points, 29.9).time, 30)
eq('past the last point there is nothing to the right', P.nextPoint(points, 60), null)

// Walking left.
eq('from the end, left lands on the last point', P.prevPoint(points, 60).time, 50)
eq('from between points, left lands on the previous', P.prevPoint(points, 25).time, 20)
eq('from exactly on a point, left moves past it', P.prevPoint(points, 30).time, 20)
eq('before the first point there is nothing to the left', P.prevPoint(points, 5), null)

// Walking right then left returns where you started.
{
  const right = P.nextPoint(points, 25)
  const back = P.prevPoint(points, right.time)
  eq('right then left comes back', back.time, 20)
}

// Stepping through the whole track.
{
  let t = 0
  const visited = []
  for (let i = 0; i < 10; i++) {
    const next = P.nextPoint(points, t)
    if (!next) break
    visited.push(next.time)
    t = next.time
  }
  eq('stepping right visits every point once', visited.join(','), '10,20,30,40,50')
}

// Nearest, for deciding what a delete key means.
eq('the nearest point within range', P.nearestPoint(points, 21, 5).time, 20)
eq('nothing when everything is too far', P.nearestPoint(points, 100, 5), null)
eq('restricted to locators, a hot cue is skipped', P.nearestPoint(points, 31, 5, 'memory'), null)
eq('and the nearest locator is found', P.nearestPoint(points, 38, 5, 'memory').time, 40)
eq('exactly on a point is distance zero', P.nearestPoint(points, 30, 0.001).time, 30)

// Empty and edge cases.
{
  const bare = P.pointsOfInterest({ cuePoint: null, hotCues: [], memoryCues: [] })
  eq('a track with no markers has no points', bare.length, 0)
  eq('and nothing to jump to', P.nextPoint(bare, 0), null)
  eq('in either direction', P.prevPoint(bare, 100), null)
  eq('and nothing to delete', P.nearestPoint(bare, 0, 10), null)
}
{
  const noCue = P.pointsOfInterest({ cuePoint: null, hotCues: [], memoryCues: [{ time: 5 }] })
  eq('a track with only a locator still navigates', noCue.length, 1)
  eq('and it is a locator', noCue[0].kind, 'memory')
}

// Two markers at the same instant must both survive, in a stable order.
{
  const stacked = P.pointsOfInterest({
    cuePoint: 12,
    hotCues: [{ index: 1, time: 12, color: '#fff', type: 'cue' }],
    memoryCues: [{ time: 12 }]
  })
  eq('all three are kept', stacked.length, 3)
  eq('ordered cue, hot cue, locator', stacked.map((p) => p.kind).join(','), 'cue,hotcue,memory')
  ok('and right still escapes the pile', P.nextPoint(stacked, 12) === null)
}
