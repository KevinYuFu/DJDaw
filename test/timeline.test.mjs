/** The grid every arrangement lane shares. */
import { gridLines, gridStepSec, timeLabel } from './.build/timeline.mjs'

const { eq, ok } = globalThis.__t

// Whatever the zoom, the lines stay about the same distance apart on screen.
for (const pxPerSec of [2, 4, 8, 16, 32, 64, 128]) {
  const gap = gridStepSec(pxPerSec) * pxPerSec
  ok(`at ${pxPerSec}px a second the lines sit ${Math.round(gap)}px apart`, gap >= 60 && gap <= 260)
}

eq('zoomed right out, the step is minutes', gridStepSec(2), 60)
eq('zoomed right in, it is a quarter second', gridStepSec(500), 0.25)

eq('lines start on the first step inside the window', gridLines(7, 25, 5).join(','), '10,15,20,25')
eq('a window with nothing in it has no lines', gridLines(10, 10, 5).length, 0)
eq('and neither does a step of nothing', gridLines(0, 10, 0).length, 0)

eq('a label is minutes and seconds', timeLabel(95, 5), '1:35')
eq('padded to two digits', timeLabel(63, 1), '1:03')
eq('and fractions once the step is under a second', timeLabel(63.25, 0.25), '1:03.25')
