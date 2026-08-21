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
  LOOP_COLOR,
  MEMORY_CUE_COLOR
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

/** Memory cues sit behind the hot cues and must not compete with them. */
const MEMORY_CUE_ALPHA = 0.55

/**
 * Playhead colour. Deliberately not in `core/constants.ts`: it is a property of
 * these two views rather than of the palette, and both take it from here.
 */
export const PLAYHEAD_COLOR = '#ffffff'

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
  sampleRate: number
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
    const b0 = (fromSec + (span * n) / colCount) * bucketsPerSec
    const b1 = (fromSec + (span * (n + 1)) / colCount) * bucketsPerSec
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
  reuse?: WaveformColumns | null
): WaveformColumns {
  const count = Math.max(1, Math.floor(width))
  const cols = columnsFor(count, reuse)
  cols.low.fill(0)
  cols.mid.fill(0)
  cols.high.fill(0)

  const span = toSec - fromSec
  if (!(span > 0)) return cols
  const scale = count / span

  for (const clip of clips) {
    if (clip.startSec >= toSec) break
    const end = clip.startSec + clip.durationSec
    if (end <= fromSec) continue

    const t0 = clip.startSec > fromSec ? clip.startSec : fromSec
    const t1 = end < toSec ? end : toSec
    const c0 = Math.round((t0 - fromSec) * scale)
    const c1 = Math.round((t1 - fromSec) * scale)
    if (c1 <= c0) continue

    // Take the source window from the rounded column edges, not from the clip
    // edges: the peaks then line up with the pixels they are drawn into, so a
    // cut does not shift the envelope by half a column.
    const s0 = clip.sourceOffsetSec + fromSec + c0 / scale - clip.startSec
    const s1 = clip.sourceOffsetSec + fromSec + c1 / scale - clip.startSec
    fillColumns(wave, s0, s1, cols, c0, c1 - c0, sampleRate)
  }
  return cols
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
  /** Vertical exaggeration. 1 means a full-scale peak exactly fills the strip. */
  gain?: number
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

  // Mono mode paints all three bands in one colour rather than computing a
  // separate envelope: mirrored bars drawn from the centre union to exactly
  // the per-column maximum of the three.
  const colors = opts.mono ? { low: opts.mono, mid: opts.mono, high: opts.mono } : opts.colors

  ctx.save()
  fillBand(ctx, cols.low, cols.width, colors.low, x, centre, half, gain)
  fillBand(ctx, cols.mid, cols.width, colors.mid, x, centre, half, gain)
  fillBand(ctx, cols.high, cols.width, colors.high, x, centre, half, gain)
  ctx.restore()
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
  gain: number
): void {
  ctx.fillStyle = color
  ctx.beginPath()
  for (let c = 0; c < count; c++) {
    const v = values[c]
    if (v <= 0) continue
    let h = v * half * gain
    if (h > half) h = half
    else if (h < MIN_BAR_HALF_PX) h = MIN_BAR_HALF_PX
    ctx.rect(x + c, centre - h, 1, h * 2)
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

export interface CueMarkerStyle {
  /** Colour of the CUE point. Hot cues use their own pad colour. */
  cueColor: string
  memoryColor: string
  /** Hot cue and CUE line width, CSS pixels. */
  lineWidth: number
  memoryLineWidth: number
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
  memoryColor: MEMORY_CUE_COLOR,
  lineWidth: 2,
  memoryLineWidth: 1,
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
 * Hot cues, the CUE point and memory cues over `[from, to]`.
 *
 * Hot cues are a line in the pad's colour with a flag at the top carrying its
 * letter; the CUE point is a line with a tab at the bottom, so the two are
 * still distinguishable when they land on the same beat.
 */
export function drawCueMarkers(
  ctx: CanvasRenderingContext2D,
  cues: readonly HotCue[],
  cuePoint: number | null,
  memoryCues: readonly MemoryCue[],
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

  ctx.fillStyle = style.memoryColor
  ctx.globalAlpha = MEMORY_CUE_ALPHA
  for (const memory of memoryCues) {
    const x = (memory.time - from) * scale
    if (x < -style.memoryLineWidth || x > width) continue
    ctx.fillRect(Math.round(x), 0, style.memoryLineWidth, height)
  }
  ctx.globalAlpha = 1

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
 * Flags hang to the right of their line and flip to its left at the right-hand
 * edge, then stay inside the view: a letter half off the canvas is unreadable,
 * and the line itself already says exactly where the cue is.
 */
function flagLeft(lineX: number, style: CueMarkerStyle, width: number): number {
  const x = lineX + style.flagWidth <= width ? lineX : lineX + style.lineWidth - style.flagWidth
  return clamp(x, 0, Math.max(0, width - style.flagWidth))
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
  /** The selected piece's edges, drawn brighter and wider. */
  selectedEdgeColor: string
  selectedEdgeWidth: number
  /** Wash over the selected piece, painted under the waveform. */
  selectedFill: string
}

export const DEFAULT_CLIP_STYLE: ClipStyle = {
  edgeColor: 'rgba(255,255,255,0.5)',
  edgeWidth: 1,
  selectedEdgeColor: '#ffffff',
  selectedEdgeWidth: 2,
  selectedFill: 'rgba(255,255,255,0.09)'
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
  if (!(span > 0) || width <= 0) return
  const scale = width / span

  ctx.save()
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    if (clip.startSec >= to) break
    const end = clip.startSec + clip.durationSec
    if (end <= from) continue

    const selected = clip.id === selectedId
    const prev = clips[i - 1]
    const next = clips[i + 1]

    // The seam between two touching pieces is one line, drawn as the later
    // piece's start, and it belongs to the selection if either side is selected.
    if (clip.startSec > 0) {
      const afterSelected =
        prev !== undefined &&
        prev.id === selectedId &&
        prev.startSec + prev.durationSec >= clip.startSec
      edge(ctx, (clip.startSec - from) * scale, selected || afterSelected, style, width, height)
    }

    // A trailing edge only where the audio actually stops: a gap after this
    // piece, or the selected piece sitting at the end of the row.
    if (next !== undefined ? next.startSec > end : selected) {
      const w = selected ? style.selectedEdgeWidth : style.edgeWidth
      edge(ctx, (end - from) * scale - w, selected, style, width, height)
    }
  }
  ctx.restore()
}

/** One division, skipped rather than half drawn when it falls outside the view. */
function edge(
  ctx: CanvasRenderingContext2D,
  x: number,
  strong: boolean,
  style: ClipStyle,
  width: number,
  height: number
): void {
  const w = strong ? style.selectedEdgeWidth : style.edgeWidth
  if (x < -w || x > width) return
  ctx.fillStyle = strong ? style.selectedEdgeColor : style.edgeColor
  ctx.fillRect(Math.round(x), 0, w, height)
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
