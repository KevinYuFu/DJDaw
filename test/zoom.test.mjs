/**
 * Zooming the timeline.
 *
 * The whole point is that what is under the pointer stays under it, so that is
 * what these check: the bar at the pointer before a zoom, and after.
 */
import { WHEEL_PERCENT, WHEEL_STEP, zoomAbout } from './.build/zoom.mjs'

const { eq, ok } = globalThis.__t

const LEAST = 4
const MOST = 256
const zoom = (view, at, factor) => zoomAbout(view, at, factor, LEAST, MOST)

/** The bar sitting under the pointer, given where the view is. */
const under = (view, at) => view.fromBar + at * view.barsInView

const close = (a, b, slack = 1e-9) => Math.abs(a - b) <= slack

// The promise: the bar under the pointer does not move.
//
// Unless the view has run back to the very start, where there is nothing left
// to scroll into and the point cannot be held. That case is checked separately.
for (const at of [0, 0.25, 0.5, 0.75, 1]) {
  for (const factor of [1 / 1.15, 1.15, 0.5, 2]) {
    const view = { fromBar: 20, barsInView: 32 }
    const after = zoom(view, at, factor)
    ok(
      `zooming ${factor < 1 ? 'in' : 'out'} at ${at} keeps the bar under the pointer`,
      close(under(after, at), under(view, at)) || after.fromBar === 0
    )
  }
}

// Away from the start, there is no excuse: the point is held exactly.
for (const at of [0, 0.25, 0.5, 0.75, 1]) {
  for (const factor of [1 / 1.15, 1.15, 0.5, 2]) {
    const view = { fromBar: 400, barsInView: 32 }
    const after = zoom(view, at, factor)
    ok(
      `far from the start, zooming ${factor < 1 ? 'in' : 'out'} at ${at} holds the point exactly`,
      close(under(after, at), under(view, at))
    )
  }
}

// And when it does run back to the start, it stops there rather than before it.
{
  const view = { fromBar: 2, barsInView: 32 }
  const after = zoom(view, 1, 2)
  eq('a zoom out near the start lands on the first bar', after.fromBar, 0)
}

// The step is stated as a percentage, and the multiplier has to agree with it.
eq('a notch is the stated percentage', WHEEL_STEP, 1 + WHEEL_PERCENT / 100)

// A notch is small on purpose: a trackpad sends many of them per gesture.
{
  const view = { fromBar: 100, barsInView: 32 }
  const notch = zoom(view, 0.5, 1 / WHEEL_STEP)
  ok('one notch does move the zoom', notch.barsInView < 32)
  ok('but only a little', notch.barsInView > 32 * 0.9)

  // A gesture is many notches, and has to add up to something useful.
  let gesture = view
  for (let i = 0; i < 30; i++) gesture = zoom(gesture, 0.5, 1 / WHEEL_STEP)
  ok('a gesture of thirty notches zooms in noticeably', gesture.barsInView < 32 * 0.7)
  ok('without flying past everything', gesture.barsInView > 32 * 0.3)

  // And it still holds the point, however many notches it takes.
  ok('the point is held across a whole gesture',
    close(gesture.fromBar + 0.5 * gesture.barsInView, 100 + 0.5 * 32, 1e-9))
}

// Zooming in shows fewer bars, out shows more.
{
  const view = { fromBar: 10, barsInView: 32 }
  ok('zooming in shows fewer bars', zoom(view, 0.5, 1 / 1.15).barsInView < 32)
  ok('zooming out shows more', zoom(view, 0.5, 1.15).barsInView > 32)
}

// The pointer position decides which way the view slides.
{
  const view = { fromBar: 20, barsInView: 32 }
  const left = zoom(view, 0, 1 / 1.15)
  const right = zoom(view, 1, 1 / 1.15)
  eq('zooming in at the left edge holds the left edge', left.fromBar, 20)
  ok('zooming in at the right edge moves the view along', right.fromBar > 20)
}

// Limits.
{
  const view = { fromBar: 5, barsInView: LEAST }
  const after = zoom(view, 0.5, 1 / 1.15)
  eq('zoomed all the way in, it goes no further', after.barsInView, LEAST)
  eq('and the view does not shift when nothing changed', after.fromBar, 5)
}
{
  const view = { fromBar: 5, barsInView: MOST }
  const after = zoom(view, 0.5, 1.15)
  eq('zoomed all the way out, it goes no further', after.barsInView, MOST)
  eq('and the view stays put', after.fromBar, 5)
}

// The timeline has a beginning.
{
  const view = { fromBar: 1, barsInView: 32 }
  const after = zoom(view, 1, 1.15)
  ok('the view never starts before the first bar', after.fromBar >= 0)
}

// A pointer off the ends is treated as being at the ends.
{
  const view = { fromBar: 20, barsInView: 32 }
  eq('past the right edge counts as the right edge',
    zoom(view, 5, 1 / 1.15).fromBar, zoom(view, 1, 1 / 1.15).fromBar)
  eq('and past the left edge as the left',
    zoom(view, -3, 1 / 1.15).fromBar, zoom(view, 0, 1 / 1.15).fromBar)
}

// Zooming in and back out returns to where it started.
{
  const view = { fromBar: 12, barsInView: 32 }
  const there = zoom(view, 0.3, 1 / 1.15)
  const back = zoom(there, 0.3, 1.15)
  ok('a zoom undone leaves the view as it was', close(back.fromBar, 12, 1e-9) && close(back.barsInView, 32, 1e-9))
}
