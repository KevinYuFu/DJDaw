/**
 * What a lane calls itself.
 *
 * A lane shows its number until a track is laid on it, and from then on it
 * carries that track's name. Later tracks on the same lane do not rename it.
 */

/** The name a lane shows, given the names lanes have taken so far. */
export function laneTitle(
  titles: Readonly<Record<string, string>>,
  id: string,
  index: number
): string {
  const taken = titles[id]
  return taken !== undefined && taken !== '' ? taken : `Track ${index + 1}`
}

/**
 * The names after a track lands on a lane. A lane that already has a name
 * keeps it, and so does one whose track has no name to give.
 */
export function nameLane(
  titles: Readonly<Record<string, string>>,
  id: string,
  trackName: string
): Record<string, string> {
  if (titles[id] !== undefined || trackName === '') return { ...titles }
  return { ...titles, [id]: trackName }
}
