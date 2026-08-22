import type { Clip } from '@shared/clips'
import type { BeatGrid, HotCue, MemoryCue, WaveformData } from '@shared/types'
import { DEFAULT_BEATS_PER_BAR, beatDurationAt, beatsInRange } from '@renderer/core/beatgrid'
import { clamp } from '@renderer/core/format'
import {
  CUE_COLOR,
  GRID_BEAT_COLOR,
  GRID_DOWNBEAT_COLOR,
  HOT_CUE_COLORS,
  HOT_CUE_LABELS,
  LOOP_COLOR
} from '@renderer/core/constants'

/**
 * Canvas drawing for both waveform views.
 *
 * Pure functions over a 2D context: no React, no store, no reading of CSS
 * variables. Every colour and metric arrives as an argument, which is what lets
 * the overview and the detailed view share one renderer while looking nothing
 * alike. Everything is laid out in CSS pixels; {@link sizeCanvas} is what makes
 * that safe on a retina panel.
 */

/** A peak too small to fill a pixel still draws a hairline rather than vanishing. */
const MIN_BAR_HALF_PX = 0.5

/**
 * Playhead colour. Deliberately not in `core/constants.ts`: it is a property of
 * these two views rather than of the palette, and both take it from here.
 */
export const PLAYHEAD_COLOR = '#ffffff'

/**
 * Locator colour, here for the same reason {@link PLAYHEAD_COLOR} is.
 *
 * Neutral on purpose. Every hue on a waveform is already spoken for — the
 * eight pad colours are hot cues and red is the CUE point — so a locator that
 * picked a colour would read as one of those. Off-white belongs to none of
 * them and still carries dark label text.
 */
export const LOCATOR_COLOR = '#dfe6f2'

/** Waveform band colours, as `BAND_COLORS` / `BAND_COLORS_DIM` supply them. */
export interface BandColors {
  low: string
  mid: string
  high: string
}

/**
 * Per-column band peaks, 0-1, one column per CSS pixel of the view. Held as
 * flat arrays so a zoomed detail view can rebuild them every frame without
 * allocating.
 */
/**
 * A column grid fixed to the track: which column is leftmost, and exactly how
 * long one is.
 *
 * Both numbers have to come from the caller. Working either of them out from a
 * left edge that slides with the playhead leaves a rounding error, and that is
 * enough to move a bucket boundary about while the audio under the column has
 * not changed.
 */
export interface ColumnGrid {
  index: number
  columnSec: number
}

export interface WaveformColumns {
  /** Column count, i.e. the pixel width these peaks were built for. */
  width: number
  low: Float32Array
  mid: Float32Array
  high: Float32Array
}

/**
 * Reduce the bucket envelope to one peak per pixel column over `[fromSec,
 * toSec]`.
 *
 * Both views go through here: the overview asks for the whole track across a
 * few hundred columns, the detail view for a couple of seconds across the same
 * columns. Where a column spans many buckets it takes their maximum, so a
 * transient never disappears between two pixels; where a bucket spans many
 * columns every one of them holds that bucket's value, so a heavily zoomed
 * view draws a plateau rather than a comb.
 *
 * `sampleRate` is the rate the bucket grid is expressed in — normally
 * `wave.sampleRate`. Pass `reuse` to write into an existing set of arrays.
 */
export function buildColumns(
  wave: WaveformData,
  fromSec: number,
  toSec: number,
  width: number,
  sampleRate: number,
  reuse?: WaveformColumns | null
): WaveformColumns {
  const count = Math.max(1, Math.floor(width))
  const out = columnsFor(count, reuse)
  fillColumns(wave, fromSec, toSec, out, 0, count, sampleRate)
  return out
}

/** A column set of `count` columns, reusing `reuse` when it is already that wide. */
function columnsFor(count: number, reuse?: WaveformColumns | null): WaveformColumns {
  if (reuse && reuse.width === count) return reuse
  return {
    width: count,
    low: new Float32Array(count),
    mid: new Float32Array(count),
    high: new Float32Array(count)
  }
}

/**
 * Fill columns `[colFrom, colFrom + colCount)` with the peaks over `[fromSec,
 * toSec]`, leaving every other column untouched.
 *
 * Split out of {@link buildColumns} so a row made of clips can be built one
 * clip at a time into a single set of arrays: nothing is allocated per clip,
 * per frame. Columns outside the array are skipped but still counted, so a
 * clip running off either edge of the view keeps its scale.
 */
export function fillColumns(
  wave: WaveformData,
  fromSec: number,
  toSec: number,
  cols: WaveformColumns,
  colFrom: number,
  colCount: number,
  sampleRate: number,
  /** Absolute bucket position of the first column and the width of one. */
  bucketGrid?: { index: number; bucketsPerColumn: number; offsetBuckets: number }
): void {
  if (colCount <= 0) return
  const first = Math.max(0, colFrom)
  const last = Math.min(cols.width, colFrom + colCount)
  if (last <= first) return

  const span = toSec - fromSec
  // A truncated cache file is readable but short; never index past what it holds.
  const buckets = Math.min(wave.bucketCount, wave.low.length, wave.mid.length, wave.high.length)
  const bucketsPerSec = wave.bucketSize > 0 ? sampleRate / wave.bucketSize : 0
  if (!(span > 0) || buckets <= 0 || !(bucketsPerSec > 0)) {
    cols.low.fill(0, first, last)
    cols.mid.fill(0, first, last)
    cols.high.fill(0, first, last)
    return
  }

  const { low, mid, high } = wave
  for (let c = first; c < last; c++) {
    // Recomputed from `fromSec` rather than accumulated: a per-column step
    // drifts audibly over a five-minute overview.
    const n = c - colFrom
    const b0 = bucketGrid
      ? (bucketGrid.index + n) * bucketGrid.bucketsPerColumn + bucketGrid.offsetBuckets
      : (fromSec + (span * n) / colCount) * bucketsPerSec
    const b1 = bucketGrid
      ? (bucketGrid.index + n + 1) * bucketGrid.bucketsPerColumn + bucketGrid.offsetBuckets
      : (fromSec + (span * (n + 1)) / colCount) * bucketsPerSec
    let i0 = Math.floor(b0)
    let i1 = Math.ceil(b1) - 1
    // A bucket wider than the column: hold the value it covers.
    if (i1 < i0) i1 = i0

    if (i1 < 0 || i0 >= buckets) {
      cols.low[c] = 0
      cols.mid[c] = 0
      cols.high[c] = 0
      continue
    }
    if (i0 < 0) i0 = 0
    if (i1 >= buckets) i1 = buckets - 1

    let l = 0
    let m = 0
    let h = 0
    for (let i = i0; i <= i1; i++) {
      if (low[i] > l) l = low[i]
      if (mid[i] > m) m = mid[i]
      if (high[i] > h) h = high[i]
    }
    cols.low[c] = l / 255
    cols.mid[c] = m / 255
    cols.high[c] = h / 255
  }
}

/**
 * Columns for a row made of clips: every clip's own slice of the source drawn
 * at its place on the timeline, and gaps left at zero so they draw as empty
 * background rather than as audio.
 *
 * This is the only correct way to draw a row once it has been cut. Timeline
 * seconds stop matching source seconds the moment a clip is rippled away or
 * moved, and a clip's `sourceOffsetSec` is what puts the two back together.
 * An uncut row is one whole-track clip and comes out identical to
 * {@link buildColumns}, which is why every deck can go through here.
 *
 * `clips` must be in timeline order — everything in `shared/clips.ts` returns
 * them that way — so this walks them once and stops at the right-hand edge
 * instead of scanning the whole row for every pixel column.
 */
export function buildClipColumns(
  wave: WaveformData,
  clips: readonly Clip[],
  fromSec: number,
  toSec: number,
  width: number,
  sampleRate: number,
  reuse?: WaveformColumns | null,
  /** Draw on a grid fixed to the track rather than to the view. */
  grid?: ColumnGrid,
  /**
   * The envelope for a piece that came from another row.
   *
   * A piece keeps playing its own audio wherever it is dropped, so it has to
   * be drawn from its own envelope too — the row's would show whatever happens
   * to sit at that offset in a different file.
   */
  waveFor?: (sourceId: string) => WaveformData | null
): WaveformColumns {
  const count = Math.max(1, Math.floor(width))
  const cols = columnsFor(count, reuse)
  cols.low.fill(0)
  cols.mid.fill(0)
  cols.high.fill(0)

  const span = toSec - fromSec
  if (!(span > 0)) return cols
  const scale = count / span
  const bucketsPerSec = wave.bucketSize > 0 ? sampleRate / wave.bucketSize : 0
  const columnTime = grid
    ? (c: number): number => (grid.index + c) * grid.columnSec
    : (c: number): number => fromSec + c / scale

  for (const clip of clips) {
    if (clip.startSec >= toSec) break
    const end = clip.startSec + clip.durationSec
    if (end <= fromSec) continue
    // A hole has no audio to draw, and its source offset is zero — drawn like
    // any other piece it would show the top of the file.
    if (clip.silent) continue

    const t0 = clip.startSec > fromSec ? clip.startSec : fromSec
    const t1 = end < toSec ? end : toSec
    const c0 = Math.round((t0 - fromSec) * scale)
    const c1 = Math.round((t1 - fromSec) * scale)
    if (c1 <= c0) continue

    // Take the source window from the rounded column edges, not from the clip
    // edges: the peaks then line up with the pixels they are drawn into, so a
    // cut does not shift the envelope by half a column.
    const s0 = clip.sourceOffsetSec + columnTime(c0) - clip.startSec
    const s1 = clip.sourceOffsetSec + columnTime(c1) - clip.startSec
    // A piece that came from another row is drawn from its own envelope: the
    // row's would show whatever happens to sit at that offset in a different
    // file.
    const envelope = (clip.sourceId && waveFor ? waveFor(clip.sourceId) : null) ?? wave
    fillColumns(
      envelope,
      s0,
      s1,
      cols,
      c0,
      c1 - c0,
      sampleRate,
      grid && {
        index: grid.index + c0,
        bucketsPerColumn: grid.columnSec * bucketsPerSec,
        offsetBuckets: (clip.sourceOffsetSec - clip.startSec) * bucketsPerSec
      }
    )
  }
  return cols
}

/** What the signal does under each column. */
export interface ColumnExtents {
  /** Lowest sample, -1 to 0. */
  min: Float32Array
  /** Highest sample, 0 to 1. */
  max: Float32Array
  /** Root mean square, 0 to 1: the body of the sound rather than its tips. */
  rms: Float32Array
}

/**
 * The lowest and highest sample under each column, read from the decoded audio.
 *
 * Not an envelope of absolute peaks: the two edges are tracked separately, so
 * what gets drawn is the shape of the signal rather than a symmetrical block.
 * On a loud master that is the whole difference between a readable waveform and
 * a solid bar, because a limited mix peaks near full scale almost everywhere
 * while the signal itself still swings through zero.
 *
 * Clips are walked exactly as {@link buildClipColumns} walks them, so a cut row
 * reads from the right part of the file.
 */
export function buildClipExtents(
  channels: readonly Float32Array[],
  clips: readonly Clip[],
  fromSec: number,
  toSec: number,
  width: number,
  sampleRate: number,
  reuse?: ColumnExtents | null,
  /** See the same argument on {@link buildClipColumns}. */
  grid?: ColumnGrid,
  /** The audio for a piece that came from another row. */
  channelsFor?: (sourceId: string) => readonly Float32Array[] | null
): ColumnExtents {
  const count = Math.max(1, Math.floor(width))
  const out =
    reuse && reuse.min.length === count && reuse.rms && reuse.rms.length === count
      ? reuse
      : {
          min: new Float32Array(count),
          max: new Float32Array(count),
          rms: new Float32Array(count)
        }
  out.min.fill(0)
  out.max.fill(0)
  out.rms.fill(0)

  const span = toSec - fromSec
  if (!(span > 0) || channels.length === 0 || !(sampleRate > 0)) return out
  const scale = count / span

  for (const clip of clips) {
    if (clip.startSec >= toSec) break
    const end = clip.startSec + clip.durationSec
    if (end <= fromSec) continue
    // A hole has no audio to draw, and its source offset is zero — drawn like
    // any other piece it would show the top of the file.
    if (clip.silent) continue

    const t0 = clip.startSec > fromSec ? clip.startSec : fromSec
    const t1 = end < toSec ? end : toSec
    const c0 = Math.round((t0 - fromSec) * scale)
    const c1 = Math.round((t1 - fromSec) * scale)
    if (c1 <= c0) continue

    // A piece that came from another row reads its own audio, not the row's.
    const own = (clip.sourceId && channelsFor ? channelsFor(clip.sourceId) : null) ?? channels
    const frames = own.length > 0 ? own[0].length : 0

    const sourceAt = (col: number): number =>
      clip.sourceOffsetSec +
      (grid ? (grid.index + col) * grid.columnSec : fromSec + col / scale) -
      clip.startSec

    for (let c = c0; c < c1; c++) {
      let i0 = Math.round(sourceAt(c) * sampleRate)
      let i1 = Math.round(sourceAt(c + 1) * sampleRate)
      if (i1 <= i0) i1 = i0 + 1
      if (i1 <= 0 || i0 >= frames) continue
      if (i0 < 0) i0 = 0
      if (i1 > frames) i1 = frames

      let lo = 0
      let hi = 0
      let sum = 0
      for (let ch = 0; ch < own.length; ch++) {
        const data = own[ch]
        for (let i = i0; i < i1; i++) {
          const v = data[i]
          if (v < lo) lo = v
          else if (v > hi) hi = v
          sum += v * v
        }
      }
      out.min[c] = lo
      out.max[c] = hi
      out.rms[c] = Math.sqrt(sum / ((i1 - i0) * own.length))
    }
  }
  return out
}

export interface WaveformDrawOptions {
  /** Strip height in CSS pixels. The mirror line sits halfway down it. */
  height: number
  /** Band colours, painted back to front: lows, then mids, then highs. */
  colors: BandColors
  /** Left edge in CSS pixels. */
  x?: number
  /** Top edge in CSS pixels. */
  y?: number
  /** Collapse the bands into one envelope in this colour: the 'mono' mode. */
  mono?: string
  /** Tint each column by its frequency balance instead of stacking the bands. */
  rgb?: boolean
  /** Opacity for the RGB pass, 1 full. The overview's played half uses this. */
  dim?: number
  /** Vertical exaggeration. 1 means a full-scale peak exactly fills the strip. */
  gain?: number
  /**
   * Columns per CSS pixel. Pass the device pixel ratio and build that many
   * more columns to draw at the panel's real resolution rather than at half of
   * it, which is what makes a transient read as a spike instead of a block.
   */
  subpixel?: number
  /**
   * Signal edges from {@link buildClipExtents}, drawn instead of the band
   * envelope. The bands still decide the colour; this only decides the shape.
   */
  extents?: ColumnExtents | null
}

/**
 * The Pioneer three-band stack: blue lows first, orange mids over them, white
 * highs on top, every band mirrored about the centre line. Painting back to
 * front is what produces the familiar look — the highs are only visible where
 * they exceed the mids, and the mids only where they exceed the lows.
 */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  cols: WaveformColumns,
  opts: WaveformDrawOptions
): void {
  const half = opts.height / 2
  if (!(half > 0) || cols.width <= 0) return
  const x = opts.x ?? 0
  const centre = (opts.y ?? 0) + half
  const gain = opts.gain ?? 1
  const step = 1 / (opts.subpixel && opts.subpixel > 0 ? opts.subpixel : 1)

  if (opts.rgb && !opts.mono) {
    ctx.save()
    if (opts.dim != null && opts.dim < 1) ctx.globalAlpha = Math.max(0, opts.dim)
    fillRgb(ctx, cols, x, centre, half, gain, step, opts.extents ?? null)
    ctx.restore()
    return
  }

  // Mono mode paints all three bands in one colour rather than computing a
  // separate envelope: mirrored bars drawn from the centre union to exactly
  // the per-column maximum of the three.
  const colors = opts.mono ? { low: opts.mono, mid: opts.mono, high: opts.mono } : opts.colors

  ctx.save()
  fillBand(ctx, cols.low, cols.width, colors.low, x, centre, half, gain, step)
  fillBand(ctx, cols.mid, cols.width, colors.mid, x, centre, half, gain, step)
  fillBand(ctx, cols.high, cols.width, colors.high, x, centre, half, gain, step)
  ctx.restore()
}

/**
 * Band weights applied before the colour is worked out.
 *
 * Bass first, then highs, then mids. A column with real low end reads red even
 * when the bands above it are just as loud, because the kick is the thing a DJ
 * is looking for; between the other two, hats and snares place a section
 * faster than the mids do.
 */
const BAND_WEIGHT = { low: 1, mid: 0.4, high: 0.55 }

/** How bright each channel can get. */
const CHANNEL_CEILING = { red: 1, green: 0.88, blue: 0.95 }

/** Above 1 tightens a channel around the band that dominates its column. */
const CHANNEL_GAMMA = { red: 2, green: 1.8, blue: 1.4 }

/**
 * How far the mids lift blue on their own.
 *
 * A column of pure mids on the green channel alone is a flat, dark green.
 * Lifting blue with it lands on the emerald rekordbox shows for the same
 * sound. Highs still own the channel: this only ever raises it.
 */
const MID_LIFTS_BLUE = 0.5

/**
 * How far a colour is lifted towards white when one band owns the column.
 *
 * A fully saturated hue on black is a neon stripe and it is hard to read a
 * shape through. Lifting keeps the hue but puts the light back in, which is
 * what a meter looks like: salmon and mint rather than red and green.
 */
const WHITE_LIFT = 0.05

/**
 * Extra lift for a column whose three bands are all about as loud.
 *
 * This is what gives the strip its contrast. A kick is bass and nothing else,
 * so it stays a deep salmon; a snare or a crash is the whole spectrum at once
 * and goes almost white. Without it every loud column comes out the same pink
 * and the detail is lost in a blob.
 */
const BROADBAND_LIFT = 0.72

/** Trim off the top so a lifted colour still has somewhere to go. */
const LEVEL = 0.94


/** Levels per channel. */
const RGB_STEPS = 16

/**
 * The RGB waveform: red lows, green mids, blue highs, white where all three
 * are present.
 *
 * Height is the loudest band, so the silhouette matches the three-band stack;
 * only the colour differs. Each channel is scaled against the loudest band in
 * its own column, which is what makes the hue show the balance of the sound
 * rather than how loud it is.
 */
function fillRgb(
  ctx: CanvasRenderingContext2D,
  cols: WaveformColumns,
  x: number,
  centre: number,
  half: number,
  gain: number,
  step: number,
  extents: ColumnExtents | null
): void {
  let open = ''
  for (let c = 0; c < cols.width; c++) {
    const lo = cols.low[c]
    const mid = cols.mid[c]
    const hi = cols.high[c]
    const band = lo > mid ? (lo > hi ? lo : hi) : mid > hi ? mid : hi
    if (band <= 0) continue

    // The RMS, not the peak: on a limited master the tips sit at full scale
    // almost everywhere, and this is the part that still moves. One flat tone
    // per column, top to bottom.
    let r = extents ? extents.rms[c] * half * gain : band * half * gain
    if (r > half) r = half
    if (r < MIN_BAR_HALF_PX) r = MIN_BAR_HALF_PX
    const top = r
    const bottom = -r

    const color = rgbColumnColor(lo, mid, hi)
    if (color !== open) {
      if (open) ctx.fill()
      ctx.fillStyle = color
      ctx.beginPath()
      open = color
    }
    ctx.rect(x + c * step, centre - top, step, top - bottom)
  }
  if (open) ctx.fill()
}

/**
 * The colour for one column of an RGB waveform, from its three band peaks.
 *
 * The bands are scaled against the loudest of the three first, so the hue
 * shows the balance of the sound rather than how loud it is, then mixed
 * through {@link BAND_TO_RGB}. Silence is black.
 */
export function rgbColumnColor(low: number, mid: number, high: number): string {
  const l = low * BAND_WEIGHT.low
  const m = mid * BAND_WEIGHT.mid
  const h = high * BAND_WEIGHT.high
  const peak = l > m ? (l > h ? l : h) : m > h ? m : h
  if (!(peak > 0)) return 'rgb(0,0,0)'

  const midRatio = m / peak
  let r = shape(l / peak, 'red')
  let g = shape(midRatio, 'green')
  let b = shape(Math.max(h / peak, MID_LIFTS_BLUE * midRatio), 'blue')

  // How evenly the three share the column, before the weighting above tilts
  // them: 0 when one band owns it, 1 when they are all equal.
  const loud = low > mid ? (low > high ? low : high) : mid > high ? mid : high
  const quiet = low < mid ? (low < high ? low : high) : mid < high ? mid : high
  const even = loud > 0 ? quiet / loud : 0
  const towardsWhite = WHITE_LIFT + BROADBAND_LIFT * even

  return `rgb(${step(lift(r, towardsWhite))},${step(lift(g, towardsWhite))},${step(lift(b, towardsWhite))})`
}

/** One channel's own curve and ceiling, as a 0-1 level. */
function shape(ratio: number, id: 'red' | 'green' | 'blue'): number {
  const r = ratio <= 0 ? 0 : ratio > 1 ? 1 : ratio
  return Math.pow(r, CHANNEL_GAMMA[id]) * CHANNEL_CEILING[id]
}

/** Towards white by `amount`, then down a touch so the lift has headroom. */
function lift(level: number, amount: number): number {
  return (level + (1 - level) * amount) * LEVEL
}

/** A 0-1 level, clamped and stepped, as a byte. */
function step(value: number): number {
  const v = value <= 0 ? 0 : value > 1 ? 1 : value
  return Math.round((Math.round(v * RGB_STEPS) * 255) / RGB_STEPS)
}

/** One band as a single path of mirrored 1 px bars — far cheaper than a fill per column. */
function fillBand(
  ctx: CanvasRenderingContext2D,
  values: Float32Array,
  count: number,
  color: string,
  x: number,
  centre: number,
  half: number,
  gain: number,
  step: number
): void {
  ctx.fillStyle = color
  ctx.beginPath()
  for (let c = 0; c < count; c++) {
    const v = values[c]
    if (v <= 0) continue
    let h = v * half * gain
    if (h > half) h = half
    else if (h < MIN_BAR_HALF_PX) h = MIN_BAR_HALF_PX
    ctx.rect(x + c * step, centre - h, step, h * 2)
  }
  ctx.fill()
}

export interface BeatGridStyle {
  beatColor: string
  downbeatColor: string
  /** Plain beat tick height as a fraction of the strip, measured from the bottom. */
  beatTickRatio: number
  /** Tick spacing below which ticks are dropped, in CSS pixels. */
  minSpacingPx: number
  lineWidth: number
}

export const DEFAULT_BEAT_GRID_STYLE: BeatGridStyle = {
  beatColor: GRID_BEAT_COLOR,
  downbeatColor: GRID_DOWNBEAT_COLOR,
  beatTickRatio: 0.22,
  minSpacingPx: 3,
  lineWidth: 1
}

/**
 * Beat ticks across `[from, to]`: downbeats full height and bright, the beats
 * between them short and dim.
 *
 * Zoomed out far enough the beats would be closer than a few pixels apart and
 * the grid becomes an unreadable wall, so only bar lines are drawn; once even
 * those crowd together nothing is drawn at all.
 */
export function drawBeatGrid(
  ctx: CanvasRenderingContext2D,
  grid: BeatGrid,
  from: number,
  to: number,
  width: number,
  height: number,
  style: BeatGridStyle = DEFAULT_BEAT_GRID_STYLE
): void {
  const span = to - from
  if (!(span > 0) || width <= 0 || grid.anchors.length === 0) return

  const beatsPerBar = grid.beatsPerBar || DEFAULT_BEATS_PER_BAR
  const pxPerBeat = (beatDurationAt(grid, from + span / 2) / span) * width
  let stride = 1
  if (pxPerBeat < style.minSpacingPx) {
    if (pxPerBeat * beatsPerBar < style.minSpacingPx) return
    stride = beatsPerBar
  }

  const ticks = beatsInRange(grid, from, to, stride)
  if (ticks.length === 0) return
  const scale = width / span
  const tickTop = height * (1 - style.beatTickRatio)

  ctx.save()
  ctx.fillStyle = style.beatColor
  ctx.beginPath()
  for (const t of ticks) {
    if (t.inBar === 0) continue
    ctx.rect(Math.round((t.time - from) * scale), tickTop, style.lineWidth, height - tickTop)
  }
  ctx.fill()

  ctx.fillStyle = style.downbeatColor
  ctx.beginPath()
  for (const t of ticks) {
    if (t.inBar !== 0) continue
    ctx.rect(Math.round((t.time - from) * scale), 0, style.lineWidth, height)
  }
  ctx.fill()
  ctx.restore()
}

export interface LocatorStyle {
  color: string
  /** Line width and opacity. The line marks the exact position. */
  lineWidth: number
  lineAlpha: number
  /** Dash pattern for the line; empty draws it solid. */
  dash: number[]
  /** Top edge of the tag band, CSS pixels from the top of the strip. */
  tagTop: number
  tagHeight: number
  /** Tag width when there is no name to show, or no room to show it. */
  nubWidth: number
  /** Length of the pointed end. Dropped on a tag too narrow to keep it. */
  tailWidth: number
  /** Names in the tags. Off in the MACRO view, where they will not fit. */
  labels: boolean
  font: string
  labelColor: string
  labelPadX: number
  maxTagWidth: number
  /** Markers closer together than this are thinned out. */
  minGapPx: number
}

/** MICRO view: room for a name, so locators carry one. */
export const DETAIL_LOCATOR_STYLE: LocatorStyle = {
  color: LOCATOR_COLOR,
  lineWidth: 1,
  lineAlpha: 0.72,
  // Dashed, because colour alone is not enough to separate a locator from a
  // hot cue at a glance: a dashed guide line reads as a marker you navigate
  // to, a solid one as a cue you fire.
  dash: [5, 4],
  // Below the hot cue flags, so the two bands never overlap and a locator name
  // is never hidden behind a pad letter.
  tagTop: 15,
  tagHeight: 12,
  nubWidth: 5,
  tailWidth: 4,
  labels: true,
  font: "10px 'SF Mono', Menlo, Consolas, monospace",
  labelColor: '#0e0e10',
  labelPadX: 4,
  maxTagWidth: 90,
  minGapPx: 5
}

/** MACRO view: 38 px tall and the whole track wide, so a tab and nothing else. */
export const OVERVIEW_LOCATOR_STYLE: LocatorStyle = {
  ...DETAIL_LOCATOR_STYLE,
  lineAlpha: 0.6,
  dash: [],
  tagTop: 0,
  tagHeight: 6,
  nubWidth: 3,
  tailWidth: 0,
  labels: false,
  minGapPx: 3
}

/**
 * Locators over `[from, to]`: a line at each one, with a tag carrying its name.
 *
 * Locators are markers dropped while listening and then walked between with
 * `D` and `F`, so the job here is to make them aimable and to keep them
 * separable from the other two things on a waveform. Hot cues are solid pad
 * colours with a letter at the very top; the CUE point is red with a tab at
 * the bottom; a locator is a neutral dashed line with a pointed tag in its own
 * band. Nothing overlaps, so a locator on the same beat as a hot cue still
 * reads as two markers.
 *
 * `locators` must be in time order — everything that writes `memoryCues` keeps
 * them sorted — so that the thinning keeps the first marker of a crowd and
 * measures the room a name has before its neighbour.
 */
export function drawLocators(
  ctx: CanvasRenderingContext2D,
  locators: readonly MemoryCue[],
  from: number,
  to: number,
  width: number,
  height: number,
  style: LocatorStyle = DETAIL_LOCATOR_STYLE
): void {
  const span = to - from
  if (!(span > 0) || width <= 0 || locators.length === 0) return
  const scale = width / span

  ctx.save()
  ctx.font = style.font
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.strokeStyle = style.color
  ctx.lineWidth = style.lineWidth
  ctx.setLineDash(style.dash)

  let lastX = Number.NEGATIVE_INFINITY
  for (let i = 0; i < locators.length; i++) {
    const x = (locators[i].time - from) * scale
    if (x < -style.lineWidth || x > width) continue
    // A cluster of locators drawn in full would merge into a solid block that
    // none of them could be picked out of, so only the first of a crowd is
    // drawn. Zooming in spreads them apart and brings the rest back.
    if (x - lastX < style.minGapPx) continue
    lastX = x

    const lineX = Math.round(x)
    ctx.globalAlpha = style.lineAlpha
    ctx.beginPath()
    // Half a pixel over, or a 1 px stroke straddles two columns and blurs.
    ctx.moveTo(lineX + style.lineWidth / 2, 0)
    ctx.lineTo(lineX + style.lineWidth / 2, height)
    ctx.stroke()

    // The tag is opaque, so the name stays readable over a loud waveform.
    ctx.globalAlpha = 1
    // The next locator caps how wide this one's name may be, so a tag never
    // runs under its neighbour's line.
    const next = locators[i + 1]
    const room = (next ? (next.time - from) * scale : width) - x
    drawLocatorTag(ctx, lineX, locators[i].name ?? '', room, width, style)
  }

  ctx.restore()
}

/**
 * One locator's tag: a pointed flag holding the name, or a plain nub when
 * there is no name or no room for one.
 *
 * An unnamed locator gets a nub rather than a number. The numbering would
 * shift the moment a locator earlier in the track was deleted, so a printed
 * number is a label that lies exactly when it is being relied on.
 */
function drawLocatorTag(
  ctx: CanvasRenderingContext2D,
  lineX: number,
  name: string,
  room: number,
  width: number,
  style: LocatorStyle
): void {
  const limit = Math.min(style.maxTagWidth, room - style.minGapPx)
  const text =
    style.labels && name !== ''
      ? fitLabel(ctx, name, limit - style.labelPadX * 2 - style.tailWidth)
      : ''
  const tagWidth =
    text === ''
      ? style.nubWidth
      : Math.min(limit, ctx.measureText(text).width + style.labelPadX * 2 + style.tailWidth)
  const tagX = tagLeft(lineX, tagWidth, style.lineWidth, width)

  ctx.fillStyle = style.color
  // The point is dropped on a tag too small to show it, which is what turns
  // the same shape into the nub.
  const tail = tagWidth >= style.tailWidth * 2 ? style.tailWidth : 0
  ctx.beginPath()
  ctx.moveTo(tagX, style.tagTop)
  ctx.lineTo(tagX + tagWidth - tail, style.tagTop)
  ctx.lineTo(tagX + tagWidth, style.tagTop + style.tagHeight / 2)
  ctx.lineTo(tagX + tagWidth - tail, style.tagTop + style.tagHeight)
  ctx.lineTo(tagX, style.tagTop + style.tagHeight)
  ctx.closePath()
  ctx.fill()

  if (text === '') return
  ctx.fillStyle = style.labelColor
  ctx.fillText(text, tagX + style.labelPadX, style.tagTop + style.tagHeight / 2)
}

/**
 * The longest leading part of `text` that fits `maxWidth`, cut short with an
 * ellipsis. Empty when not even one character fits.
 *
 * Cheap enough to run per frame: there are a handful of locators in view and
 * the loop stops as soon as the string fits.
 */
function fitLabel(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (ctx.measureText(text).width <= maxWidth) return text
  for (let n = text.length - 1; n > 0; n--) {
    const cut = `${text.slice(0, n)}…`
    if (ctx.measureText(cut).width <= maxWidth) return cut
  }
  return ''
}

export interface CueMarkerStyle {
  /** Colour of the CUE point. Hot cues use their own pad colour. */
  cueColor: string
  /** Hot cue and CUE line width, CSS pixels. */
  lineWidth: number
  /** Pad letters in the flags. Off in the overview, where they will not fit. */
  labels: boolean
  flagWidth: number
  flagHeight: number
  font: string
  /** Letter colour inside a flag; mirrors --text-inverse. */
  labelColor: string
}

export const DETAIL_CUE_STYLE: CueMarkerStyle = {
  cueColor: CUE_COLOR,
  lineWidth: 2,
  labels: true,
  flagWidth: 13,
  flagHeight: 12,
  font: "bold 9px 'SF Mono', Menlo, Consolas, monospace",
  labelColor: '#0e0e10'
}

/** The overview strip is 38 px tall: tabs instead of lettered flags. */
export const OVERVIEW_CUE_STYLE: CueMarkerStyle = {
  ...DETAIL_CUE_STYLE,
  lineWidth: 1,
  labels: false,
  flagWidth: 3,
  flagHeight: 5
}

/**
 * Hot cues and the CUE point over `[from, to]`.
 *
 * Hot cues are a line in the pad's colour with a flag at the top carrying its
 * letter; the CUE point is a line with a tab at the bottom, so the two are
 * still distinguishable when they land on the same beat. Locators are drawn
 * separately, by {@link drawLocators}, and belong under these.
 */
export function drawCueMarkers(
  ctx: CanvasRenderingContext2D,
  cues: readonly HotCue[],
  cuePoint: number | null,
  from: number,
  to: number,
  width: number,
  height: number,
  style: CueMarkerStyle = DETAIL_CUE_STYLE
): void {
  const span = to - from
  if (!(span > 0) || width <= 0) return
  const scale = width / span

  ctx.save()

  if (cuePoint != null) {
    const x = (cuePoint - from) * scale
    if (x >= -style.lineWidth && x <= width) {
      const lineX = Math.round(x)
      ctx.fillStyle = style.cueColor
      ctx.fillRect(lineX, 0, style.lineWidth, height)
      ctx.fillRect(flagLeft(lineX, style, width), height - style.flagHeight, style.flagWidth, style.flagHeight)
    }
  }

  for (const cue of cues) {
    const x = (cue.time - from) * scale
    if (x < -style.lineWidth || x > width) continue
    const lineX = Math.round(x)
    const flagX = flagLeft(lineX, style, width)
    ctx.fillStyle = cue.color || HOT_CUE_COLORS[cue.index % HOT_CUE_COLORS.length]
    ctx.fillRect(lineX, 0, style.lineWidth, height)
    ctx.fillRect(flagX, 0, style.flagWidth, style.flagHeight)
    if (!style.labels) continue
    const label = cue.index >= 0 && cue.index < HOT_CUE_LABELS.length ? HOT_CUE_LABELS[cue.index] : ''
    if (label === '') continue
    ctx.fillStyle = style.labelColor
    ctx.font = style.font
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, flagX + style.flagWidth / 2, style.flagHeight / 2)
  }

  ctx.restore()
}

/**
 * Flags and tags hang to the right of their line and flip to its left at the
 * right-hand edge, then stay inside the view: a label half off the canvas is
 * unreadable, and the line itself already says exactly where the marker is.
 */
function tagLeft(lineX: number, tagWidth: number, lineWidth: number, width: number): number {
  const x = lineX + tagWidth <= width ? lineX : lineX + lineWidth - tagWidth
  return clamp(x, 0, Math.max(0, width - tagWidth))
}

function flagLeft(lineX: number, style: CueMarkerStyle, width: number): number {
  return tagLeft(lineX, style.flagWidth, style.lineWidth, width)
}

export interface LoopStyle {
  color: string
  fillAlpha: number
  edgeAlpha: number
  edgeWidth: number
}

export const DEFAULT_LOOP_STYLE: LoopStyle = {
  color: LOOP_COLOR,
  fillAlpha: 0.16,
  edgeAlpha: 0.85,
  edgeWidth: 2
}

/** The active loop as a wash between its in and out points, with solid edges. */
export function drawLoopRegion(
  ctx: CanvasRenderingContext2D,
  startSec: number,
  endSec: number,
  from: number,
  to: number,
  width: number,
  height: number,
  style: LoopStyle = DEFAULT_LOOP_STYLE
): void {
  const span = to - from
  if (!(span > 0) || !(endSec > startSec) || width <= 0) return
  const scale = width / span
  const x0 = (startSec - from) * scale
  const x1 = (endSec - from) * scale
  if (x1 < 0 || x0 > width) return

  const left = Math.max(x0, 0)
  const right = Math.min(x1, width)
  ctx.save()
  ctx.fillStyle = style.color
  ctx.globalAlpha = style.fillAlpha
  ctx.fillRect(left, 0, right - left, height)
  ctx.globalAlpha = style.edgeAlpha
  if (x0 >= 0) ctx.fillRect(Math.round(x0), 0, style.edgeWidth, height)
  if (x1 <= width) ctx.fillRect(Math.round(x1) - style.edgeWidth, 0, style.edgeWidth, height)
  ctx.restore()
}

export interface PlayheadStyle {
  color: string
  width: number
  /** Shadow blur in CSS pixels; 0 for a flat line. */
  glow: number
}

export const DEFAULT_PLAYHEAD_STYLE: PlayheadStyle = { color: PLAYHEAD_COLOR, width: 2, glow: 5 }

export function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  x: number,
  height: number,
  style: PlayheadStyle = DEFAULT_PLAYHEAD_STYLE
): void {
  ctx.save()
  ctx.fillStyle = style.color
  if (style.glow > 0) {
    ctx.shadowColor = style.color
    ctx.shadowBlur = style.glow
  }
  ctx.fillRect(Math.round(x) - style.width / 2, 0, style.width, height)
  ctx.restore()
}

/**
 * How the pieces of a cut row are marked out.
 *
 * These colours live here rather than in `core/constants.ts` for the same
 * reason {@link PLAYHEAD_COLOR} does: they are chrome belonging to this view,
 * not part of the track palette.
 */
export interface ClipStyle {
  /** Vertical division between two pieces. */
  edgeColor: string
  edgeWidth: number
  /**
   * Space left between two pieces, in CSS px. Zero: the pieces meet.
   *
   * The audio either side of a cut is continuous and the waveform should look
   * it. What marks the cut is the two outlines meeting, not a hole.
   */
  cardGap: number
  /** Corner radius of a piece, in CSS px. */
  cardRadius: number
  /**
   * Height of the bar across the top of a piece, in CSS px. Zero draws none.
   *
   * It is what a piece is picked up by. Dragging anywhere on the waveform is a
   * scrub, so moving a piece needs somewhere of its own to be grabbed.
   */
  handleHeight: number
  handleFill: string
  selectedHandleFill: string
  /**
   * The selected piece's outline: brighter, and wider by one device pixel.
   *
   * One is the smallest step there is, and it is enough. Any more and the
   * selection stops being a mark on the piece and starts being the loudest
   * thing on a row that is already busy.
   */
  selectedEdgeColor: string
  selectedEdgeWidth: number
  /** Wash over the selected piece, painted under the waveform. */
  selectedFill: string
  /** Ground under a piece, painted below the waveform. */
  bandFill: string
}

export const DEFAULT_CLIP_STYLE: ClipStyle = {
  edgeColor: 'rgba(255,255,255,0.72)',
  edgeWidth: 1.5,
  cardGap: 0,
  cardRadius: 2,
  handleHeight: 8,
  handleFill: 'rgba(255,255,255,0.3)',
  selectedHandleFill: 'rgba(255,255,255,0.31)',
  selectedEdgeColor: 'rgba(255,255,255,0.8)',
  selectedEdgeWidth: 2,
  selectedFill: 'rgba(255,255,255,0.025)',
  bandFill: 'rgba(255,255,255,0.07)'
}

/**
 * The MACRO view uses the same numbers, so a piece is marked the same amount
 * whichever strip it is looked at on. Spread rather than copied: two lists of
 * the same values drift the moment one of them is tuned.
 */
export const OVERVIEW_CLIP_STYLE: ClipStyle = {
  ...DEFAULT_CLIP_STYLE,
  // No handle here. The strip is thirty pixels tall, and a press anywhere on a
  // piece already picks it up — the handle exists in the zoomed view only
  // because a press there means scrub.
  handleHeight: 0
}

/**
 * The selected piece as a background wash over `[from, to]`.
 *
 * Drawn before the waveform so the envelope stays the brightest thing in the
 * row: the selection lifts the piece off the background rather than veiling it.
 * Nothing is drawn when no piece is selected, which is every performance deck.
 */
export function drawClipHighlight(
  ctx: CanvasRenderingContext2D,
  clips: readonly Clip[],
  selectedId: string | null,
  from: number,
  to: number,
  width: number,
  height: number,
  style: ClipStyle = DEFAULT_CLIP_STYLE
): void {
  const span = to - from
  if (selectedId === null || !(span > 0) || width <= 0) return
  const scale = width / span

  for (const clip of clips) {
    if (clip.id !== selectedId) continue
    const x0 = Math.max((clip.startSec - from) * scale, 0)
    const x1 = Math.min((clip.startSec + clip.durationSec - from) * scale, width)
    if (x1 <= x0) return
    ctx.save()
    ctx.fillStyle = style.selectedFill
    ctx.fillRect(x0, 0, x1 - x0, height)
    ctx.restore()
    return
  }
}

/** How a switched-off piece is drawn: the colour taken out, and dimmer. */
export const DISABLED_FILTER = 'grayscale(1) brightness(0.62)'

/** The parts of the view the switched-off pieces cover, and the rest. */
export interface ClipMasks {
  on: Path2D
  off: Path2D
}

/**
 * Masks for drawing the switched-off pieces apart from the rest.
 *
 * Null when nothing is switched off, so the usual row is drawn in one pass
 * with no clipping at all.
 */
export function disabledMasks(
  clips: readonly Clip[],
  from: number,
  to: number,
  width: number,
  height: number
): ClipMasks | null {
  const span = to - from
  if (!(span > 0) || width <= 0) return null
  if (!clips.some((clip) => clip.disabled)) return null
  const scale = width / span
  const on = new Path2D()
  const off = new Path2D()
  for (const clip of clips) {
    const x0 = Math.max((clip.startSec - from) * scale, 0)
    const x1 = Math.min((clip.startSec + clip.durationSec - from) * scale, width)
    if (x1 <= x0) continue
    const into = clip.disabled ? off : on
    into.rect(x0, 0, x1 - x0, height)
  }
  return { on, off }
}

/** Width of the line that shows where a piece dragged in from another row lands. */
export const DROP_MARKER_WIDTH = 2
const DROP_MARKER_COLOR = 'rgba(255,255,255,0.9)'

/**
 * Where the drop line sits on a strip, or null when the point is not in view.
 *
 * A point at either end is nudged in far enough to be drawn whole; a point
 * outside the window gets no line at all, rather than one pinned to the edge
 * pointing at a moment that is not there.
 */
export function dropMarkerX(
  atSec: number,
  from: number,
  to: number,
  width: number
): number | null {
  const span = to - from
  if (!(span > 0) || width <= 0 || !Number.isFinite(atSec)) return null
  const half = DROP_MARKER_WIDTH / 2
  const x = ((atSec - from) / span) * width
  if (x < -half || x > width + half) return null
  return Math.min(Math.max(x, half), width - half)
}

/** The line showing where a piece dragged in from another row would land. */
export function drawDropMarker(
  ctx: CanvasRenderingContext2D,
  atSec: number,
  from: number,
  to: number,
  width: number,
  height: number
): void {
  const x = dropMarkerX(atSec, from, to, width)
  if (x === null) return
  ctx.save()
  ctx.fillStyle = DROP_MARKER_COLOR
  ctx.fillRect(x - DROP_MARKER_WIDTH / 2, 0, DROP_MARKER_WIDTH, height)
  ctx.restore()
}

/**
 * The divisions between pieces, drawn over the waveform.
 *
 * Only real edits get a line. The start of the row and the end of the last
 * piece are not cuts, and neither is the seam between two pieces that still
 * touch — that seam is one line, drawn as the later piece's start. So an uncut
 * row, which is one whole-track clip, draws nothing at all and the performance
 * view is untouched.
 *
 * `clips` must be in timeline order.
 */
/**
 * A wash under every other piece, so a cut row reads as blocks rather than as
 * a run of audio with lines through it.
 *
 * Nothing is drawn for a row that has never been cut: one piece covering the
 * whole track would just tint the strip for no reason.
 */
/** A piece's rectangle on screen, with the gap between pieces taken out. */
function cardRect(
  clip: Clip,
  from: number,
  scale: number,
  width: number,
  style: ClipStyle
): { x: number; w: number } | null {
  const half = style.cardGap / 2
  const x = (clip.startSec - from) * scale + half
  const right = (clip.startSec + clip.durationSec - from) * scale - half
  if (right <= 0 || x >= width) return null
  return { x, w: right - x }
}

export function drawClipBands(
  ctx: CanvasRenderingContext2D,
  clips: readonly Clip[],
  from: number,
  to: number,
  width: number,
  height: number,
  style: ClipStyle = DEFAULT_CLIP_STYLE
): void {
  const span = to - from
  if (clips.length < 2 || !(span > 0) || width <= 0) return
  const scale = width / span

  ctx.save()
  ctx.fillStyle = style.bandFill
  for (const clip of clips) {
    if (clip.startSec >= to) break
    if (clip.startSec + clip.durationSec <= from) continue
    const r = cardRect(clip, from, scale, width, style)
    if (!r) continue
    ctx.beginPath()
    ctx.roundRect(r.x, 0.5, r.w, height - 1, style.cardRadius)
    ctx.fill()
  }
  ctx.restore()
}

export function drawClipEdges(
  ctx: CanvasRenderingContext2D,
  clips: readonly Clip[],
  selectedId: string | null,
  from: number,
  to: number,
  width: number,
  height: number,
  style: ClipStyle = DEFAULT_CLIP_STYLE
): void {
  const span = to - from
  if (clips.length < 2 || !(span > 0) || width <= 0) return
  const scale = width / span

  ctx.save()


  for (const clip of clips) {
    if (clip.startSec >= to) break
    if (clip.startSec + clip.durationSec <= from) continue
    const r = cardRect(clip, from, scale, width, style)
    if (!r) continue

    const selected = clip.id === selectedId
    const w = selected ? style.selectedEdgeWidth : style.edgeWidth
    const inset = w / 2
    ctx.beginPath()
    ctx.roundRect(r.x + inset, inset, r.w - w, height - w, style.cardRadius)
    if (selected) {
      ctx.fillStyle = style.selectedFill
      ctx.fill()
    }

    // The grab bar, rounded all the way round so it reads as its own thing
    // sitting on the piece rather than as the top of the card.
    const h = style.handleHeight
    if (h > 0) {
      ctx.beginPath()
      ctx.roundRect(r.x + inset, inset, r.w - w, h, style.cardRadius)
      ctx.fillStyle = selected ? style.selectedHandleFill : style.handleFill
      ctx.fill()
    }
    ctx.lineWidth = w
    ctx.strokeStyle = selected ? style.selectedEdgeColor : style.edgeColor
    ctx.stroke()
  }
  ctx.restore()
}

/** One division, skipped rather than half drawn when it falls outside the view. */

/**
 * How a piece being dragged is previewed at the place it would land.
 *
 * A filled block with a bright outline, not a copy of the waveform: the MACRO
 * strip is short, and re-drawing the envelope at the destination would leave
 * the eye comparing two sets of bars instead of reading one target.
 */
export interface ClipGhostStyle {
  /** Wash inside the block. */
  fill: string
  edgeColor: string
  edgeWidth: number
  /** Narrowest the block may draw, so a short piece is still visible. */
  minWidth: number
}

export const DEFAULT_CLIP_GHOST_STYLE: ClipGhostStyle = {
  fill: 'rgba(255,255,255,0.18)',
  edgeColor: '#ffffff',
  edgeWidth: 2,
  minWidth: 3
}

/**
 * Where a dragged piece would land if it were dropped now, over `[from, to]`.
 *
 * Drawn last, over the waveform and the markers, because during a drag it is
 * the thing being aimed: the answer to "where does this go" has to be the
 * brightest mark on the strip.
 */
export function drawClipGhost(
  ctx: CanvasRenderingContext2D,
  startSec: number,
  durationSec: number,
  from: number,
  to: number,
  width: number,
  height: number,
  style: ClipGhostStyle = DEFAULT_CLIP_GHOST_STYLE
): void {
  const span = to - from
  if (!(span > 0) || width <= 0 || !(durationSec > 0)) return
  const scale = width / span

  const x0 = (startSec - from) * scale
  const x1 = Math.max((startSec + durationSec - from) * scale, x0 + style.minWidth)
  if (x1 < 0 || x0 > width) return

  ctx.save()
  ctx.fillStyle = style.fill
  ctx.fillRect(x0, 0, x1 - x0, height)
  // Inset by half the line width: a stroke straddles its path, so an outline
  // on the block's own edges would lose half of its top and bottom off-canvas.
  const inset = style.edgeWidth / 2
  ctx.strokeStyle = style.edgeColor
  ctx.lineWidth = style.edgeWidth
  ctx.strokeRect(
    x0 + inset,
    inset,
    Math.max(x1 - x0 - style.edgeWidth, 0),
    Math.max(height - style.edgeWidth, 0)
  )
  ctx.restore()
}

/** Backing-store size a canvas of this CSS box needs at this pixel ratio. */
function backingSize(cssWidth: number, cssHeight: number, dpr: number): { w: number; h: number } {
  const ratio = dpr > 0 ? dpr : 1
  return { w: Math.max(1, Math.round(cssWidth * ratio)), h: Math.max(1, Math.round(cssHeight * ratio)) }
}

/** True when the backing store no longer matches the CSS box or the pixel ratio. */
export function canvasNeedsResize(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  dpr: number
): boolean {
  const { w, h } = backingSize(cssWidth, cssHeight, dpr)
  return canvas.width !== w || canvas.height !== h
}

/**
 * Point a canvas at a CSS-pixel coordinate system backed by device pixels, and
 * hand back its context.
 *
 * Safe to call every frame: `width`/`height` are only touched when they
 * actually change — assigning either clears the canvas — and the transform
 * that assignment resets is re-applied each time.
 */
export function sizeCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  dpr: number
): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const ratio = dpr > 0 ? dpr : 1
  const { w, h } = backingSize(cssWidth, cssHeight, dpr)
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  return ctx
}
