/**
 * Beat jump on the arrangement.
 *
 * The arrangement has one grid for everything on it, so a jump is worked out
 * from the master tempo rather than from any track's own beats: the playhead
 * moves by a whole number of grid beats and lands the same distance from the
 * downbeat it started from.
 */

/**
 * Beats one press of the jump moves.
 *
 * A phrase is four bars of four, so sixteen puts the playhead one phrase on and
 * keeps it in step with the arrangement's own phrase lines.
 */
export const BEAT_JUMP_BEATS = 16

/** Seconds one beat lasts on a grid running at `bpm`. */
export function beatSeconds(bpm: number): number {
  return 60 / bpm
}

/**
 * Where the playhead lands after jumping `beats` grid beats from `seconds`.
 *
 * Negative beats jump back. The timeline has no room before its start, so a
 * jump back from near the beginning stops there rather than going negative.
 */
export function beatJumpTo(seconds: number, beats: number, bpm: number): number {
  return Math.max(0, seconds + beats * beatSeconds(bpm))
}
