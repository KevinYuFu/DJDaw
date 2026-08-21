/** RGB waveform colouring: red lows, green mids, blue highs. */
import { rgbColumnColor } from './.build/waveformRender.mjs'

const { eq, ok } = globalThis.__t

const chan = (color) => color.slice(4, -1).split(',').map(Number)

eq('silence is black', rgbColumnColor(0, 0, 0), 'rgb(0,0,0)')

const [r1, g1, b1] = chan(rgbColumnColor(1, 0, 0))
eq('bass alone is pure red', `${r1},${g1},${b1}`, '255,0,0')
const [r2, g2, b2] = chan(rgbColumnColor(0, 1, 0))
eq('mids alone are pure green', `${r2},${g2},${b2}`, '0,255,0')
const [r3, g3, b3] = chan(rgbColumnColor(0, 0, 1))
eq('highs alone are pure blue', `${r3},${g3},${b3}`, '0,0,255')

eq('all three equal is white', rgbColumnColor(0.7, 0.7, 0.7), 'rgb(255,255,255)')

// The brightest channel is always the loudest band, at any level.
for (const [low, mid, high, want] of [
  [0.9, 0.4, 0.2, 0],
  [0.2, 0.9, 0.4, 1],
  [0.2, 0.4, 0.9, 2],
  [0.05, 0.02, 0.01, 0],
  [0.325, 0.259, 0.137, 0]
]) {
  const c = chan(rgbColumnColor(low, mid, high))
  ok(`loudest band ${want} is the brightest channel in ${low}/${mid}/${high}`, c.indexOf(Math.max(...c)) === want)
  eq(`and it is at full brightness for ${low}/${mid}/${high}`, Math.max(...c), 255)
}

// Level does not change the hue, only the height of the bar.
eq('hue ignores level', rgbColumnColor(0.8, 0.4, 0.2), rgbColumnColor(0.2, 0.1, 0.05))

// Channels stay ordered with their bands.
const c = chan(rgbColumnColor(1, 0.5, 0.25))
ok('a band twice as loud gets a brighter channel', c[0] > c[1] && c[1] > c[2])
ok('every channel is a byte', c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255))
