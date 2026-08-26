/**
 * What a lane calls itself: its number until a track lands on it, that track's
 * name from then on.
 */
import { laneTitle, nameLane } from './.build/laneTitle.mjs'

const { eq, ok } = globalThis.__t

eq('an untouched lane shows its number', laneTitle({}, 'lane-1', 0), 'Track 1')
eq('counted from one, not zero', laneTitle({}, 'lane-4', 3), 'Track 4')
eq('a named lane shows its name', laneTitle({ 'lane-2': 'Da Funk' }, 'lane-2', 1), 'Da Funk')
eq('one lane naming itself leaves the rest', laneTitle({ 'lane-1': 'Da Funk' }, 'lane-2', 1), 'Track 2')

// The first track onto a lane names it.
{
  const after = nameLane({}, 'lane-1', 'Da Funk')
  eq('the first track names the lane', after['lane-1'], 'Da Funk')
  eq('and the lane shows it', laneTitle(after, 'lane-1', 0), 'Da Funk')
}

// Every later track leaves that name alone.
{
  const once = nameLane({}, 'lane-1', 'Da Funk')
  const twice = nameLane(once, 'lane-1', 'Around The World')
  eq('a second track does not rename the lane', twice['lane-1'], 'Da Funk')
  const thrice = nameLane(twice, 'lane-1', 'Aerodynamic')
  eq('nor a third', thrice['lane-1'], 'Da Funk')
}

// Lanes name themselves one at a time.
{
  const a = nameLane({}, 'lane-1', 'Da Funk')
  const b = nameLane(a, 'lane-3', 'Aerodynamic')
  eq('lane 1 keeps its own name', laneTitle(b, 'lane-1', 0), 'Da Funk')
  eq('lane 3 takes its own', laneTitle(b, 'lane-3', 2), 'Aerodynamic')
  eq('lane 2 is still a number', laneTitle(b, 'lane-2', 1), 'Track 2')
}

// A track with no name to give leaves the lane free to take a later one.
{
  const empty = nameLane({}, 'lane-1', '')
  eq('a nameless track does not name the lane', laneTitle(empty, 'lane-1', 0), 'Track 1')
  eq('so the next one still can', nameLane(empty, 'lane-1', 'Da Funk')['lane-1'], 'Da Funk')
}

ok('naming a lane does not change what it was given', (() => {
  const before = { 'lane-1': 'Da Funk' }
  nameLane(before, 'lane-2', 'Aerodynamic')
  return Object.keys(before).length === 1
})())
