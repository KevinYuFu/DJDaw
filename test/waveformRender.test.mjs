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

/**
 * Clip bands: the wash that turns a cut row into blocks.
 *
 * Drawn against a stub context, so this is about what gets painted rather than
 * about what a screenshot happens to look like.
 */
import { drawClipBands, DEFAULT_CLIP_STYLE } from './.build/waveformRender.mjs'

function stubCtx() {
  const rects = []
  return {
    rects,
    fillStyle: '',
    save() {},
    restore() {},
    fillRect(x, y, w, h) {
      rects.push({ x: Math.round(x), w: Math.round(w), fill: this.fillStyle })
    },
    beginPath() {
      this.pending = null
    },
    roundRect(x, y, w) {
      this.pending = { x: Math.round(x), w: Math.round(w) }
    },
    fill() {
      if (this.pending) rects.push({ ...this.pending, fill: this.fillStyle })
    },
    stroke() {}
  }
}
const clip = (startSec, durationSec, id) => ({ id, startSec, durationSec, sourceOffsetSec: 0 })

{
  const ctx = stubCtx()
  drawClipBands(ctx, [clip(0, 100, 'c1')], 0, 100, 1000, 50)
  ok(`an uncut row is never tinted — ${ctx.rects.length} rects`, ctx.rects.length === 0)
}
{
  const ctx = stubCtx()
  drawClipBands(ctx, [], 0, 100, 1000, 50)
  ok('an empty row is never tinted', ctx.rects.length === 0)
}
{
  // Four pieces across the view: the second and the fourth get the wash.
  const ctx = stubCtx()
  const clips = [clip(0, 10, 'a'), clip(10, 10, 'b'), clip(20, 10, 'c'), clip(30, 10, 'd')]
  drawClipBands(ctx, clips, 0, 40, 400, 50)
  ok(`every piece gets a card — ${ctx.rects.length}`, ctx.rects.length === 4)
  ok('in the band colour', ctx.rects.every((r) => r.fill === DEFAULT_CLIP_STYLE.bandFill))
  const gap = DEFAULT_CLIP_STYLE.cardGap
  ok(`each is inset by half the gap — ${JSON.stringify(ctx.rects[1])}`,
    Math.abs(ctx.rects[1].x - (100 + gap / 2)) < 1 && Math.abs(ctx.rects[1].w - (100 - gap)) < 1)
  ok('so there is space between two of them',
    ctx.rects[1].x > ctx.rects[0].x + ctx.rects[0].w)
}
{
  // Only what is on screen, clipped to the edges.
  const ctx = stubCtx()
  const clips = [clip(0, 10, 'a'), clip(10, 10, 'b'), clip(20, 10, 'c')]
  drawClipBands(ctx, clips, 15, 25, 100, 50)
  ok(`the pieces on screen are drawn — ${JSON.stringify(ctx.rects)}`, ctx.rects.length === 2)
}
