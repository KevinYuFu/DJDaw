/**
 * Which way a warp goes.
 *
 * This has been inverted twice. A rate is source frames consumed per
 * arrangement frame, so a track that has to play *slower* than it was recorded
 * consumes *fewer* of them: below 1 is slower, and there is no reading of the
 * numbers where a lower master tempo makes anything speed up.
 */
import { playbackRate } from './.build/playbackRate.mjs'

const { eq, ok } = globalThis.__t

// The case that was wrong: a 150 track dropped onto a 120 grid.
eq('a 150 track on a 120 grid plays slower', playbackRate(150, 120), 0.8)
ok('which is below 1', playbackRate(150, 120) < 1)

// And the other way.
eq('a 120 track on a 150 grid plays faster', playbackRate(120, 150), 1.25)
ok('which is above 1', playbackRate(120, 150) > 1)

eq('a track already at the master tempo is left alone', playbackRate(128, 128), 1)

// Raising the master tempo always speeds a track up, whatever it was recorded
// at; lowering it always slows it down.
for (const fileBpm of [90, 123.48, 128, 150, 174]) {
  const slower = playbackRate(fileBpm, 100)
  const faster = playbackRate(fileBpm, 140)
  ok(`raising the grid speeds a ${fileBpm} track up`, faster > slower)
  ok(`and the ${fileBpm} track lands on the grid`, Math.abs(fileBpm * faster - 140) < 1e-9)
}

// The length a clip occupies is the file length divided by the rate, so slower
// really does mean it takes longer to play.
const fileSec = 200
eq('slowing a track down makes its clip longer', fileSec / playbackRate(150, 120), 250)
eq('speeding it up makes it shorter', fileSec / playbackRate(150, 200), 150)

// Nothing to go on means no warp rather than a divide by zero.
eq('an unanalysed track is not warped', playbackRate(0, 128), 1)
eq('and neither is one with no grid to sit on', playbackRate(128, 0), 1)
