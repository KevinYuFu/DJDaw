/**
 * How fast a file has to run to sit on the master tempo.
 *
 * The warp itself is live, inside the deck: it reads its file at this rate and
 * a stretcher after it puts the pitch back where it was.
 */

/**
 * How fast to play a file so it lands on another tempo.
 *
 * Below 1 is slower: a 174 file on a 123 master plays at 0.71, which is what
 * puts its beats where the master's are.
 */
export function playbackRate(fileBpm: number, masterBpm: number): number {
  if (!(fileBpm > 0) || !(masterBpm > 0)) return 1
  return masterBpm / fileBpm
}

