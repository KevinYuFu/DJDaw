/**
 * What a session starts as.
 *
 * A session is the lanes and everything sitting on them. Opening the
 * arrangement and clearing it both build from here, so a cleared session and a
 * freshly opened one are the same thing.
 */

/**
 * Lanes the arrangement opens with.
 *
 * Eight, so a track and the four stems split out of it fit together with room
 * left over. Colours run out after four and start again, which is why a lane
 * says its name rather than relying on its colour alone.
 */
export const LANE_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const

/** The grid a session starts on, in BPM. */
export const DEFAULT_MASTER_BPM = 120

/** The id of the lane at `index`, counting from 1 the way the lanes read. */
export function laneId(index: number): string {
  return `lane-${index + 1}`
}

/** A lane with nothing on it. The timeline library fills in the rest. */
export interface SessionLane {
  id: string
  name: string
  clips: never[]
  muted: boolean
  soloed: boolean
  volume: number
  pan: number
}

/** The lanes a session opens with: all of them, all empty. */
export function freshLanes(): SessionLane[] {
  return LANE_NAMES.map((name, i) => ({
    id: laneId(i),
    name,
    clips: [],
    muted: false,
    soloed: false,
    volume: 1,
    pan: 0
  }))
}
