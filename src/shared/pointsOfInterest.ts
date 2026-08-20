/**
 * Points of interest: everything worth jumping to on a track.
 *
 * Memory cues are treated as locators, the way Ableton treats them — markers
 * you drop while listening and then navigate between, rather than pads you
 * trigger. Hot cues and the CUE point are jumpable too, so one pair of keys
 * walks the lot in time order.
 *
 * Pure and dependency-free so the navigation can be tested without a deck.
 */

import type { Track } from './types'

export type PointKind = 'cue' | 'hotcue' | 'memory'

export interface PointOfInterest {
  time: number
  kind: PointKind
  /** Short label for the UI: 'CUE', a pad letter, or the locator's name. */
  label: string
}

/**
 * How close counts as "already here".
 *
 * Without this, jumping right from a point you are sitting on would land back
 * on the same point, and the keys would feel dead. 30 ms is under a frame of
 * audio at any sane tempo but comfortably wider than playhead jitter.
 */
export const POINT_EPSILON_SEC = 0.03

const PAD_LETTERS = 'ABCDEFGH'

/**
 * Every point on a track, in time order.
 *
 * Points at the same instant are kept — two markers can legitimately share a
 * position — but the sort is stable by kind so the order does not flicker
 * between renders.
 */
export function pointsOfInterest(track: Pick<Track, 'hotCues' | 'memoryCues' | 'cuePoint'>): PointOfInterest[] {
  const points: PointOfInterest[] = []

  if (track.cuePoint != null) {
    points.push({ time: track.cuePoint, kind: 'cue', label: 'CUE' })
  }
  for (const cue of track.hotCues) {
    points.push({
      time: cue.time,
      kind: 'hotcue',
      label: cue.name || PAD_LETTERS[cue.index] || String(cue.index + 1)
    })
  }
  track.memoryCues.forEach((memory, i) => {
    points.push({ time: memory.time, kind: 'memory', label: memory.name || `${i + 1}` })
  })

  const rank: Record<PointKind, number> = { cue: 0, hotcue: 1, memory: 2 }
  return points.sort((a, b) => a.time - b.time || rank[a.kind] - rank[b.kind])
}

/** The first point after `time`, or null when there is nothing to the right. */
export function nextPoint(
  points: readonly PointOfInterest[],
  time: number,
  epsilon = POINT_EPSILON_SEC
): PointOfInterest | null {
  for (const point of points) {
    if (point.time > time + epsilon) return point
  }
  return null
}

/** The last point before `time`, or null when there is nothing to the left. */
export function prevPoint(
  points: readonly PointOfInterest[],
  time: number,
  epsilon = POINT_EPSILON_SEC
): PointOfInterest | null {
  let found: PointOfInterest | null = null
  for (const point of points) {
    if (point.time < time - epsilon) found = point
    else break
  }
  return found
}

/**
 * The point closest to `time`, within `maxDistanceSec`.
 *
 * Used to decide which locator a delete key means. Deleting the nearest marker
 * only when one is genuinely close avoids removing something off screen that
 * the user had forgotten about.
 */
export function nearestPoint(
  points: readonly PointOfInterest[],
  time: number,
  maxDistanceSec: number,
  kind?: PointKind
): PointOfInterest | null {
  let best: PointOfInterest | null = null
  let bestDistance = Infinity
  for (const point of points) {
    if (kind && point.kind !== kind) continue
    const distance = Math.abs(point.time - time)
    if (distance <= maxDistanceSec && distance < bestDistance) {
      best = point
      bestDistance = distance
    }
  }
  return best
}
