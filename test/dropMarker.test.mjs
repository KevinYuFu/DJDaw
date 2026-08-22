/**
 * The line that shows where a piece dragged in from another row will land.
 *
 * It has to stay on the strip: a drop at either end still needs a visible
 * line, and a point outside the window has none at all.
 */
import { DROP_MARKER_WIDTH, dropMarkerX } from './.build/waveformRender.mjs'

const { eq, ok } = globalThis.__t
const half = DROP_MARKER_WIDTH / 2

eq('halfway along a 100s strip lands halfway across', dropMarkerX(50, 0, 100, 400), 200)
eq('the start of the row is pulled in far enough to draw', dropMarkerX(0, 0, 100, 400), half)
eq('and so is the end', dropMarkerX(100, 0, 100, 400), 400 - half)
eq('a window that does not start at zero counts from its own left edge',
  dropMarkerX(30, 20, 40, 200), 100)
eq('a point before the window has no line', dropMarkerX(-500, 0, 100, 400), null)
eq('nor does one past its right edge', dropMarkerX(140, 0, 100, 400), null)
eq('a strip with no width has no line', dropMarkerX(10, 0, 100, 0), null)
eq('a window with no span has no line', dropMarkerX(10, 50, 50, 400), null)
ok('a point a hair off the left edge is nudged in rather than dropped',
  dropMarkerX(-0.1, 0, 100, 400) === half)
