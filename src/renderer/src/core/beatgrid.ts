import type { BeatGrid, BeatGridAnchor } from '@shared/types'

/**
 * Beat grid maths.
 *
 * A grid maps seconds to a continuous, fractional beat index and back. Beat 0
 * sits on `anchors[0].time`; earlier beats have negative indices. Every
 * position-changing feature in the app (beat jump, quantise, loops, hot cue
 * snapping, grid rendering) is expressed in beat space, which is what keeps
 * them phase-correct across tempo changes the way a CDJ is.
 */

export interface CompiledAnchor extends BeatGridAnchor {
  /** Fractional beat index at `time`. */
  beat: number
  /** Seconds per beat in this section. */
  secPerBeat: number
}

export interface CompiledGrid {
  anchors: CompiledAnchor[]
  beatsPerBar: number
}

export const DEFAULT_BEATS_PER_BAR = 4

export function makeGrid(firstBeatTime: number, bpm: number, beatsPerBar = DEFAULT_BEATS_PER_BAR): BeatGrid {
  return { anchors: [{ time: firstBeatTime, bpm }], beatsPerBar }
}

/**
 * Precompute the cumulative beat index of every anchor. Cheap, but called on
 * every rendered frame, so results are memoised against the grid object.
 */
const compileCache = new WeakMap<BeatGrid, CompiledGrid>()

export function compileGrid(grid: BeatGrid): CompiledGrid {
  const cached = compileCache.get(grid)
  if (cached) return cached

  const sorted = [...grid.anchors].sort((a, b) => a.time - b.time)
  const anchors: CompiledAnchor[] = []
  let beat = 0
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]
    const secPerBeat = 60 / a.bpm
    if (i > 0) {
      const prev = anchors[i - 1]
      beat = prev.beat + (a.time - prev.time) / prev.secPerBeat
    }
    anchors.push({ time: a.time, bpm: a.bpm, beat, secPerBeat })
  }
  const compiled: CompiledGrid = { anchors, beatsPerBar: grid.beatsPerBar || DEFAULT_BEATS_PER_BAR }
  compileCache.set(grid, compiled)
  return compiled
}

/** Index of the anchor section containing `time` (clamped to the first one). */
function anchorIndexAtTime(g: CompiledGrid, time: number): number {
  const a = g.anchors
  let lo = 0
  let hi = a.length - 1
  if (time < a[0].time) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (a[mid].time <= time) lo = mid
    else hi = mid - 1
  }
  return lo
}

function anchorIndexAtBeat(g: CompiledGrid, beat: number): number {
  const a = g.anchors
  let lo = 0
  let hi = a.length - 1
  if (beat < a[0].beat) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (a[mid].beat <= beat) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Fractional beat index at `time`. Extrapolates outside the grid. */
export function beatAtTime(grid: BeatGrid, time: number): number {
  const g = compileGrid(grid)
  const a = g.anchors[anchorIndexAtTime(g, time)]
  return a.beat + (time - a.time) / a.secPerBeat
}

/** Inverse of {@link beatAtTime}. */
export function timeAtBeat(grid: BeatGrid, beat: number): number {
  const g = compileGrid(grid)
  const a = g.anchors[anchorIndexAtBeat(g, beat)]
  return a.time + (beat - a.beat) * a.secPerBeat
}

/** Seconds per beat in effect at `time`. */
export function beatDurationAt(grid: BeatGrid, time: number): number {
  const g = compileGrid(grid)
  return g.anchors[anchorIndexAtTime(g, time)].secPerBeat
}

/** Tempo in effect at `time`. */
export function bpmAt(grid: BeatGrid, time: number): number {
  const g = compileGrid(grid)
  return g.anchors[anchorIndexAtTime(g, time)].bpm
}

/**
 * Snap a time to the grid. `division` is in beats: 1 snaps to every beat,
 * 4 to every bar, 0.5 to every eighth.
 */
export function snapTimeToBeat(grid: BeatGrid, time: number, division = 1): number {
  const b = beatAtTime(grid, time)
  return timeAtBeat(grid, Math.round(b / division) * division)
}

/** Time of the nearest grid beat to `time`. */
export function nearestBeatTime(grid: BeatGrid, time: number): number {
  return snapTimeToBeat(grid, time, 1)
}

/**
 * Beat jump, matching rekordbox.
 *
 * The playhead moves by exactly `beats` grid beats — it walks the grid rather
 * than adding a fixed number of seconds, so a jump stays phase-locked even
 * across a tempo change. With quantise on, the position is first pulled to the
 * nearest beat, which is what makes repeated jumps land dead on the grid the
 * way the hardware does. With quantise off the sub-beat offset is preserved,
 * so a jump from an off-grid position stays equally off-grid.
 */
export function beatJumpTime(grid: BeatGrid, time: number, beats: number, quantize: boolean): number {
  const current = beatAtTime(grid, time)
  const base = quantize ? Math.round(current) : current
  return timeAtBeat(grid, base + beats)
}

/** Bar-relative position of a beat index: 0 is the downbeat. */
export function beatInBar(grid: BeatGrid, beat: number): number {
  const bpb = grid.beatsPerBar || DEFAULT_BEATS_PER_BAR
  const r = Math.round(beat) % bpb
  return r < 0 ? r + bpb : r
}

/** Zero-based bar number of a beat index. Negative before the first downbeat. */
export function barAtBeat(grid: BeatGrid, beat: number): number {
  const bpb = grid.beatsPerBar || DEFAULT_BEATS_PER_BAR
  return Math.floor(Math.round(beat) / bpb)
}

export interface BeatTick {
  time: number
  beat: number
  /** 0 for a downbeat. */
  inBar: number
}

/**
 * Every grid beat whose time falls in [from, to], in order. Used by the
 * waveform renderers; `stride` lets a zoomed-out view draw only downbeats.
 */
export function beatsInRange(grid: BeatGrid, from: number, to: number, stride = 1): BeatTick[] {
  const ticks: BeatTick[] = []
  if (to < from) return ticks
  const startBeat = Math.ceil(beatAtTime(grid, from) / stride) * stride
  const endBeat = beatAtTime(grid, to)
  // Guard against a pathological grid producing an unbounded loop.
  const maxTicks = 20000
  for (let b = startBeat; b <= endBeat && ticks.length < maxTicks; b += stride) {
    ticks.push({ time: timeAtBeat(grid, b), beat: b, inBar: beatInBar(grid, b) })
  }
  return ticks
}

// ---------------------------------------------------------------------------
// Grid editing
// ---------------------------------------------------------------------------

/** Slide the whole grid in time, keeping every tempo section intact. */
export function shiftGrid(grid: BeatGrid, deltaSec: number): BeatGrid {
  return { ...grid, anchors: grid.anchors.map((a) => ({ ...a, time: a.time + deltaSec })) }
}

/** Nudge the grid by a fraction of a beat, for fine alignment. */
export function nudgeGrid(grid: BeatGrid, beatFraction: number): BeatGrid {
  return shiftGrid(grid, beatFraction * beatDurationAt(grid, grid.anchors[0].time))
}

/**
 * Re-anchor the grid so that a downbeat lands exactly on `time`, rekordbox's
 * "set as downbeat". The tempo is untouched; only the phase moves, and it
 * moves by less than one bar so the grid does not jump across the track.
 */
export function setDownbeatAt(grid: BeatGrid, time: number): BeatGrid {
  const bpb = grid.beatsPerBar || DEFAULT_BEATS_PER_BAR
  const beat = beatAtTime(grid, time)
  const nearestBar = Math.round(beat / bpb) * bpb
  return shiftGrid(grid, time - timeAtBeat(grid, nearestBar))
}

/**
 * Change the tempo of the section containing `time`, pinning the anchor so the
 * grid does not slide out from under the playhead.
 */
export function setBpmAt(grid: BeatGrid, time: number, bpm: number): BeatGrid {
  if (!(bpm > 0)) return grid
  const g = compileGrid(grid)
  const idx = anchorIndexAtTime(g, time)
  const anchors = grid.anchors.map((a, i) => (i === idx ? { ...a, bpm } : a))
  return { ...grid, anchors }
}

/** Scale the tempo of the whole grid, e.g. halve or double it. */
export function scaleGridBpm(grid: BeatGrid, factor: number): BeatGrid {
  if (!(factor > 0)) return grid
  return { ...grid, anchors: grid.anchors.map((a) => ({ ...a, bpm: a.bpm * factor })) }
}

