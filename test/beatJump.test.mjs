/**
 * Beat jump on the arrangement.
 *
 * A jump has to move a whole number of grid beats and keep whatever the
 * playhead was off the downbeat, so that is what these check — along with the
 * start of the timeline, which a jump back cannot go past.
 */
import { BEAT_JUMP_BEATS, beatJumpTo, beatSeconds } from './.build/beatJump.mjs'

const { eq, ok } = globalThis.__t

// ------------------------------------------------------------------- a beat

eq('a beat at 120 is half a second', beatSeconds(120), 0.5)
eq('a beat at 60 is a second', beatSeconds(60), 1)
eq('a beat at 174 is shorter', beatSeconds(174), 60 / 174)

// -------------------------------------------------------------- the jump size

eq('one press moves a phrase', BEAT_JUMP_BEATS, 16)

// ------------------------------------------------------------------ jumping

// 16 beats at 120 is four bars, which is eight seconds.
eq('forward from the start', beatJumpTo(0, BEAT_JUMP_BEATS, 120), 8)
eq('forward again', beatJumpTo(8, BEAT_JUMP_BEATS, 120), 16)
eq('back the same distance', beatJumpTo(16, -BEAT_JUMP_BEATS, 120), 8)

// Faster grid, shorter beats, shorter jump.
eq('the jump follows the tempo', beatJumpTo(0, BEAT_JUMP_BEATS, 240), 4)
eq('and a slow grid jumps further', beatJumpTo(0, BEAT_JUMP_BEATS, 60), 16)

// There and back is where it started.
for (const bpm of [60, 120, 128, 174]) {
  const from = 40
  eq(`out and back at ${bpm} lands where it started`, beatJumpTo(beatJumpTo(from, BEAT_JUMP_BEATS, bpm), -BEAT_JUMP_BEATS, bpm), from)
}

// -------------------------------------------------- keeping the sub-beat offset

// A playhead a fifth of a beat late stays a fifth of a beat late.
const offset = 0.1
const landed = beatJumpTo(offset, BEAT_JUMP_BEATS, 120)
eq('a jump carries the offset with it', landed, 8 + offset)
eq('so the distance from the downbeat is unchanged', landed % beatSeconds(120), offset)

// ----------------------------------------------------------- the start of it

eq('a jump back from near the start stops at the start', beatJumpTo(2, -BEAT_JUMP_BEATS, 120), 0)
eq('and from the start it stays there', beatJumpTo(0, -BEAT_JUMP_BEATS, 120), 0)
ok('never before the start', beatJumpTo(0.5, -BEAT_JUMP_BEATS, 174) >= 0)

// A jump that exactly reaches the start reaches it, rather than stopping short.
eq('a jump that lands on the start lands on it', beatJumpTo(8, -BEAT_JUMP_BEATS, 120), 0)
