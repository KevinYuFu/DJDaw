/**
 * Beat grid maths. These are the invariants the whole app leans on: if a beat
 * jump drifts off the grid, every edit built with it lands late.
 */
import * as G from './.build/beatgrid.mjs'

const { eq, ok } = globalThis.__t
const SPB = 60 / 128 // seconds per beat at 128 BPM

const g = G.makeGrid(0.4321, 128)

eq('beat index at the first downbeat is 0', G.beatAtTime(g, 0.4321), 0)
eq('one beat later is beat 1', G.beatAtTime(g, 0.4321 + SPB), 1)
eq('before the first downbeat the index goes negative', G.beatAtTime(g, 0.4321 - SPB), -1)
eq('time <-> beat round-trips', G.timeAtBeat(g, G.beatAtTime(g, 12.345)), 12.345)

const onBeat32 = G.timeAtBeat(g, 32)
eq('beat jump +16', G.beatJumpTime(g, onBeat32, 16, true), G.timeAtBeat(g, 48))
eq('beat jump -16', G.beatJumpTime(g, onBeat32, -16, true), G.timeAtBeat(g, 16))

// Quantise is the difference between "lands on the grid" and "stays as wrong as
// it started", which is exactly how rekordbox behaves.
const offGrid = onBeat32 + 0.13
eq('quantised jump from off-grid snaps to the grid', G.beatJumpTime(g, offGrid, 16, true), G.timeAtBeat(g, 48))
eq('unquantised jump preserves the sub-beat offset', G.beatJumpTime(g, offGrid, 16, false), offGrid + 16 * SPB)

let t = offGrid
for (let i = 0; i < 200; i++) t = G.beatJumpTime(g, t, 16, true)
eq('200 quantised jumps accumulate no drift', G.beatAtTime(g, t), 32 + 200 * 16)

// A jump must walk the grid, so it stays phase-locked across a tempo change.
const vari = { anchors: [{ time: 0, bpm: 120 }, { time: 60, bpm: 140 }], beatsPerBar: 4 }
eq('beat index at the tempo change', G.beatAtTime(vari, 60), 120)
const before = G.timeAtBeat(vari, 112)
const after = G.beatJumpTime(vari, before, 16, true)
eq('a jump across a tempo change lands 16 beats later', G.beatAtTime(vari, after), 128)
eq('and is not a fixed number of seconds', after, 60 + 8 * (60 / 140))

eq('beat 0 is a downbeat', G.beatInBar(g, 0), 0)
eq('beat 7 is the 4th beat of its bar', G.beatInBar(g, 7), 3)
eq('bar positions stay positive before beat 0', G.beatInBar(g, -1), 3)
eq('beat 9 is in bar 2', G.barAtBeat(g, 9), 2)

const redown = G.setDownbeatAt(g, 10)
eq('set-downbeat puts a beat exactly on that time', G.beatAtTime(redown, 10) % 1, 0)
eq('and it is a downbeat, not just any beat', G.beatInBar(redown, G.beatAtTime(redown, 10)), 0)
ok('set-downbeat moves the grid by less than one bar',
  Math.abs(redown.anchors[0].time - g.anchors[0].time) < 4 * SPB + 1e-9)

const ticks = G.beatsInRange(g, 0, 5)
ok('rendered ticks stay inside the requested range', ticks.every((x) => x.time >= 0 && x.time <= 5))
eq('ticks are one beat apart', ticks[1].time - ticks[0].time, SPB)
ok('a stride of 4 yields only downbeats', G.beatsInRange(g, 0, 10, 4).every((x) => x.inBar === 0))

eq('snap to the nearest beat', G.snapTimeToBeat(g, onBeat32 + 0.2), onBeat32)
eq('snap to the nearest bar', G.snapTimeToBeat(g, G.timeAtBeat(g, 33), 4), onBeat32)

eq('scaling the grid halves the tempo', G.scaleGridBpm(g, 0.5).anchors[0].bpm, 64)
eq('nudging the grid moves it by a fraction of a beat', G.nudgeGrid(g, 0.25).anchors[0].time, 0.4321 + SPB / 4)
