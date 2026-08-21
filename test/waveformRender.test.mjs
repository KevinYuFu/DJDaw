/**
 * RGB waveform colouring. Bass first, then highs, then mids: a column with real
 * low end has to read red, and between the other two the highs win.
 */
import { rgbColumnColor } from './.build/waveformRender.mjs'

const { eq, ok } = globalThis.__t
const chan = (c) => c.slice(4, -1).split(',').map(Number)

eq('silence is black', rgbColumnColor(0, 0, 0), 'rgb(0,0,0)')

const kick = chan(rgbColumnColor(1, 0.1, 0.15))
ok(`a kick is red — ${kick}`, kick[0] === 255 && kick[1] < 32 && kick[2] < 32)

const full = chan(rgbColumnColor(1, 0.95, 0.95))
ok(`bass under a full mix still reads red — ${full}`, full[0] === 255 && full[0] > full[1] && full[0] > full[2])

const loudMids = chan(rgbColumnColor(1, 1, 0.3))
ok(`bass beats mids of the same level — ${loudMids}`, loudMids[0] > loudMids[1])

const loudHighs = chan(rgbColumnColor(1, 0.3, 1))
ok(`bass beats highs of the same level — ${loudHighs}`, loudHighs[0] > loudHighs[2])

const mids = chan(rgbColumnColor(0.15, 1, 0.2))
ok(`mids with no bass are green — ${mids}`, mids[1] > mids[0] && mids[1] > mids[2])

const midsAndHighs = chan(rgbColumnColor(0.1, 1, 1))
ok(`highs beat mids of the same level — ${midsAndHighs}`, midsAndHighs[2] > midsAndHighs[1])

const hat = chan(rgbColumnColor(0.15, 0.2, 1))
ok(`a hat with no bass is blue — ${hat}`, hat[2] > 220 && hat[2] > hat[0] * 4 && hat[2] > hat[1] * 4)

ok('green never reaches full', chan(rgbColumnColor(0, 1, 0))[1] < 255)

eq('hue ignores level', rgbColumnColor(0.8, 0.4, 0.2), rgbColumnColor(0.2, 0.1, 0.05))
ok('every channel is a byte', chan(rgbColumnColor(1, 0.5, 0.25)).every((v) => Number.isInteger(v) && v >= 0 && v <= 255))
