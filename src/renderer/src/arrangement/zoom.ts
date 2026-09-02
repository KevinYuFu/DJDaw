/**
 * Zooming the timeline.
 *
 * Whatever is under the pointer stays under the pointer. Zoom in on a downbeat
 * and it does not slide away while the bars grow around it.
 */

/**
 * How much one notch of the wheel changes the zoom, as a percentage.
 *
 * A trackpad sends dozens of notches for one gesture, so this is per notch and
 * not per gesture. It is the only number that decides how a zoom feels.
 */
export const WHEEL_PERCENT = 2

/** That percentage as the multiplier {@link zoomAbout} takes. */
export const WHEEL_STEP = 1 + WHEEL_PERCENT / 100

/** What the view is showing: where it starts, and how much of it fits. */
export interface View {
  /** Bar at the left edge. Fractional. */
  fromBar: number
  /** Bars across the whole timeline. */
  barsInView: number
}

/**
 * The view after zooming about a point.
 *
 * `at` is where the pointer sits across the timeline, 0 at the left edge and 1
 * at the right. `factor` above 1 shows more bars, below 1 fewer.
 *
 * The timeline never starts before its own beginning, so a zoom near the left
 * edge cannot always keep its point exactly: there is nothing to scroll into.
 */
export function zoomAbout(
  view: View,
  at: number,
  factor: number,
  least: number,
  most: number
): View {
  const held = clamp(at, 0, 1)
  const barsInView = clamp(view.barsInView * factor, least, most)
  const under = view.fromBar + held * view.barsInView
  return { fromBar: Math.max(0, under - held * barsInView), barsInView }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
