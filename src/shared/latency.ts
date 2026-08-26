/**
 * Output latency.
 *
 * `AudioContext.currentTime` is the audio being rendered. The device plays it
 * a little later, so a playhead drawn from `currentTime` runs ahead of the
 * sound and the beat grid appears to sit off the music by that much.
 *
 * Everything the app shows, and everything it captures from a running
 * transport, works from the audible clock instead. Scheduling still works from
 * the render clock: that is the one the worklet and the device queue run on.
 */

/** Largest latency taken seriously, in seconds. Beyond this the figure is junk. */
const MAX_LATENCY_SEC = 1

/**
 * `outputLatency` as a number that can be subtracted. Not every context
 * reports one, and a device change can leave it absent or nonsensical.
 */
export function outputLatencySec(ctx: { outputLatency?: number }): number {
  const raw = ctx.outputLatency
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(raw, MAX_LATENCY_SEC)
}

/** The moment on the context's clock whose audio is leaving the speakers now. */
export function audibleTime(currentTime: number, latencySec: number): number {
  return currentTime - latencySec
}
