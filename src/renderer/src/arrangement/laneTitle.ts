/**
 * What a lane calls itself.
 *
 * A lane with nothing on it shows its number. A lane carries the name of the
 * track laid on it while that track is there; tracks laid on top of it do not
 * rename it, and emptying the lane hands it back its number.
 */

/** The name a lane shows. */
export function laneTitle(
  titles: Readonly<Record<string, string>>,
  id: string,
  index: number,
  hasClips: boolean
): string {
  const taken = titles[id]
  return hasClips && taken ? taken : `Track ${index + 1}`
}

/** The names after a track lands on a lane that had nothing on it. */
export function nameLane(
  titles: Readonly<Record<string, string>>,
  id: string,
  trackName: string
): Record<string, string> {
  if (trackName === '') return { ...titles }
  return { ...titles, [id]: trackName }
}
