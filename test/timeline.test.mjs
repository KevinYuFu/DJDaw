/**
 * The bar-and-beat grid the arrangement shares.
 *
 * It follows the arrangement's tempo, and how fine it is drawn follows the
 * zoom, so the lines stay about the same distance apart on screen.
 */
import {
  BEATS_PER_BAR,
  barLabel,
  gridBeats,
  gridLines,
  secPerBar,
  secPerBeat,
  snapSec
} from './.build/timeline.mjs'

const { eq, ok } = globalThis.__t

eq('a beat at 120 is half a second', secPerBeat(120), 0.5)
eq('and a bar is two', secPerBar(120), 2)
eq('at 174 a beat is shorter', +secPerBeat(174).toFixed(4), 0.3448)

// However far in or out, the lines stay a readable distance apart.
for (const pxPerSec of [2, 4, 8, 16, 32, 64, 128]) {
  const gap = gridBeats(120, pxPerSec) * secPerBeat(120) * pxPerSec
  // Zoomed right out there is nothing coarser than four bars, so the lines do
  // come closer together there.
  ok(`at ${pxPerSec}px a second the lines sit ${Math.round(gap)}px apart`,
    pxPerSec <= 8 ? gap > 8 : gap >= 40 && gap <= 340)
}
eq('zoomed right out it is four bars', gridBeats(120, 2), 16)
eq('zoomed right in it is a sixteenth', gridBeats(120, 900), 0.25)

// Lines come back knowing where they are in the music.
{
  const lines = gridLines(0, 8, 120, 4)
  eq('a bar every two seconds at 120', lines.map((l) => l.sec).join(','), '0,2,4,6,8')
  eq('numbered from one', lines[0].bar, 1)
  eq('and the next one is bar two', lines[1].bar, 2)
  ok('every one of them is a downbeat', lines.every((l) => l.onBar && l.beat === 1))
  eq('a bar is labelled by its number', barLabel(lines[2]), '3')
}
{
  const lines = gridLines(0, 2, 120, 1)
  eq('a line a beat at 120 is every half second', lines.map((l) => l.sec).join(','), '0,0.5,1,1.5,2')
  eq('the second is beat two of bar one', barLabel(lines[1]), '1.2')
  eq('and the fifth is the top of bar two', barLabel(lines[4]), '2')
  eq('four beats to the bar', BEATS_PER_BAR, 4)
}
eq('a window that starts part way in begins on the next line',
  gridLines(1.2, 3, 120, 1).map((l) => l.sec).join(','), '1.5,2,2.5,3')
eq('nothing before the start of time', gridLines(-5, 1, 120, 1)[0].sec, 0)

// Everything that lands on the timeline snaps to it.
eq('a moment snaps to the nearest line', snapSec(2.1, 120, 4), 2)
eq('rounding to the one it is closest to', snapSec(3.4, 120, 4), 4)
eq('a finer division catches more of them', snapSec(2.1, 120, 1), 2)
eq('and never before the start', snapSec(-9, 120, 4), 0)
eq('a nonsense tempo leaves it alone', snapSec(2.1, 0, 4), 2.1)
