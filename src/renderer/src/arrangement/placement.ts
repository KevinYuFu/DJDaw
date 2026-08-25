import { playbackRate } from '@renderer/analysis/playbackRate'

/**
 * Where a track lands when it is dropped on a lane.
 *
 * Used both to make the clip and to draw the preview of it under the cursor.
 */

export interface PlacementRequest {
  /** Length of the source file in frames. */
  sourceFrames: number
  /** Seconds into the file where its first downbeat is. */
  downbeatSec: number
  /** The tempo the file was recorded at, 0 when it has not been analysed. */
  trackBpm: number
  /** The grid it is being dropped onto. */
  masterBpm: number
  /** Where the drop lands, in arrangement seconds, already snapped. */
  atSeconds: number
  sampleRate: number
}

/** Every field a clip needs, in arrangement frames, plus the speed to read at. */
export interface Placement {
  startSample: number
  durationSamples: number
  offsetSamples: number
  sourceDurationSamples: number
  /** Source frames consumed per arrangement frame. */
  rate: number
}

/**
 * The track's first downbeat lands on the drop point, putting it in phase with
 * the grid.
 *
 * The intro before that downbeat sits ahead of the drop point. Whatever would
 * run before zero is trimmed.
 */
export function placeClip(req: PlacementRequest): Placement {
  const { sourceFrames, downbeatSec, trackBpm, masterBpm, atSeconds, sampleRate } = req
  const rate = playbackRate(trackBpm, masterBpm)
  const introFrames = (Math.max(0, downbeatSec) * sampleRate) / rate
  const wholeFrames = sourceFrames / rate
  const dropFrame = Math.max(0, Math.round(atSeconds * sampleRate))
  const startSample = Math.max(0, Math.round(dropFrame - introFrames))
  const offsetSamples = Math.round(Math.max(0, introFrames - dropFrame))
  return {
    startSample,
    durationSamples: Math.max(1, Math.round(wholeFrames - offsetSamples)),
    offsetSamples,
    sourceDurationSamples: Math.round(wholeFrames),
    rate
  }
}
