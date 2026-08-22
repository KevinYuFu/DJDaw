/**
 * The one grid every lane is drawn against.
 *
 * The step is chosen from the zoom rather than fixed, so the lines stay about
 * the same distance apart on screen however far in or out the arrangement is.
 */

/** Steps to choose between, in seconds. */
const STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300] as const

/** Roughly how far apart the lines want to be, in pixels. */
const WANT_PX = 90

/** How often to draw a line, in seconds, at a given zoom. */
export function gridStepSec(pxPerSec: number): number {
  if (!(pxPerSec > 0)) return STEPS[STEPS.length - 1]
  for (const step of STEPS) {
    if (step * pxPerSec >= WANT_PX) return step
  }
  return STEPS[STEPS.length - 1]
}

/** The grid lines in a window, in seconds. */
export function gridLines(fromSec: number, toSec: number, stepSec: number): number[] {
  if (!(stepSec > 0) || !(toSec > fromSec)) return []
  const out: number[] = []
  const first = Math.ceil(fromSec / stepSec) * stepSec
  for (let at = first; at <= toSec; at += stepSec) out.push(Number(at.toFixed(6)))
  return out
}

/** A grid line's label: minutes and seconds, and fractions when zoomed right in. */
export function timeLabel(sec: number, stepSec: number): string {
  const whole = Math.floor(sec)
  const mins = Math.floor(whole / 60)
  const secs = whole % 60
  const base = `${mins}:${String(secs).padStart(2, '0')}`
  if (stepSec >= 1) return base
  const frac = Math.round((sec - whole) * 100)
  return `${base}.${String(frac).padStart(2, '0')}`
}
