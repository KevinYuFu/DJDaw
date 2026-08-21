/**
 * RGB waveform colouring.
 *
 * Bass first, then highs, then mids — a column with real low end has to read
 * red, and between the other two the highs win. Colours are lifted towards
 * white so the strip reads like a meter rather than a set of neon stripes,
 * which means these check which channel leads, not that the others are dark.
 */
import { rgbColumnColor } from './.build/waveformRender.mjs'

const { eq, ok } = globalThis.__t
const chan = (c) => c.slice(4, -1).split(',').map(Number)
/** How far the leading channel is ahead of the next one, 0-255. */
const lead = (c) => { const s = [...c].sort((a, b) => b - a); return s[0] - s[1] }

eq('silence is black', rgbColumnColor(0, 0, 0), 'rgb(0,0,0)')

const kick = chan(rgbColumnColor(1, 0.1, 0.15))
ok(`a kick leads on red — ${kick}`, kick[0] === Math.max(...kick) && lead(kick) > 64)

const full = chan(rgbColumnColor(1, 0.95, 0.95))
ok(`bass under a full mix still leads on red — ${full}`, full[0] === Math.max(...full))

const loudMids = chan(rgbColumnColor(1, 1, 0.3))
ok(`bass beats mids of the same level — ${loudMids}`, loudMids[0] > loudMids[1])

const loudHighs = chan(rgbColumnColor(1, 0.3, 1))
ok(`bass beats highs of the same level — ${loudHighs}`, loudHighs[0] > loudHighs[2])

const mids = chan(rgbColumnColor(0.15, 1, 0.2))
ok(`mids with no bass lead on green — ${mids}`, mids[1] === Math.max(...mids))

const hat = chan(rgbColumnColor(0.15, 0.2, 1))
ok(`a hat with no bass leads on blue — ${hat}`, hat[2] === Math.max(...hat) && lead(hat) > 64)

const both = chan(rgbColumnColor(0.1, 1, 1))
ok(`highs beat mids of the same level — ${both}`, both[2] > both[1])

// Contrast: what one band owns keeps its colour, what every band shares goes
// white. Without this every loud column is the same pink.
const sat = (c) => { const mx = Math.max(...c), mn = Math.min(...c); return mx ? (mx - mn) / mx : 0 }
const bassOnly = chan(rgbColumnColor(1, 0.1, 0.15))
const broadband = chan(rgbColumnColor(1, 0.95, 0.95))
ok(`bass alone keeps its colour — ${bassOnly} sat ${sat(bassOnly).toFixed(2)}`, sat(bassOnly) > 0.55)
ok(`a broadband hit goes near white — ${broadband} sat ${sat(broadband).toFixed(2)}`, sat(broadband) < 0.25)
ok('and the broadband one is the brighter of the two', Math.min(...broadband) > Math.min(...bassOnly))
ok('green never reaches full', chan(rgbColumnColor(0, 1, 0))[1] < 255)

eq('hue ignores level', rgbColumnColor(0.8, 0.4, 0.2), rgbColumnColor(0.2, 0.1, 0.05))
ok('every channel is a byte', chan(rgbColumnColor(1, 0.5, 0.25)).every((v) => Number.isInteger(v) && v >= 0 && v <= 255))
