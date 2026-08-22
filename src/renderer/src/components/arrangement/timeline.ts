/**
 * The bar-and-beat grid every lane is drawn against.
 *
 * The arrangement has a tempo of its own, and every clip on it plays at
 * whatever speed matches that tempo, so one grid serves all of them. How fine
 * a division is drawn follows the zoom, and everything that lands on the
 * timeline snaps to it.
 */

/** Beats in a bar. */
export const BEATS_PER_BAR = 4

/** Divisions to choose between, in beats: a sixteenth up to four bars. */
const DIVISIONS = [0.25, 0.5, 1, 2, 4, 8, 16] as const

/** Roughly how far apart the lines want to be, in pixels. */
const WANT_PX = 80

export function secPerBeat(bpm: number): number {
  return bpm > 0 ? 60 / bpm : 0.5
}

export function secPerBar(bpm: number): number {
  return secPerBeat(bpm) * BEATS_PER_BAR
}

/** How often to draw a line, in beats, at a given tempo and zoom. */
export function gridBeats(bpm: number, pxPerSec: number): number {
  const perBeat = secPerBeat(bpm) * pxPerSec
  // The finest division that still leaves the lines far enough apart to read.
  for (const beats of DIVISIONS) {
    if (beats * perBeat >= WANT_PX) return beats
  }
  // Further out than four bars: draw four bars anyway rather than a sixteenth,
  // which would be a wall of lines.
  return DIVISIONS[DIVISIONS.length - 1]
}

/** One line of the grid. */
export interface GridLine {
  sec: number
  /** Bar number, counting from 1. */
  bar: number
  /** Beat inside the bar, counting from 1. */
  beat: number
  /** Whether it falls on the start of a bar, which is drawn stronger. */
  onBar: boolean
}

/** The lines in a window, at the division the zoom asks for. */
export function gridLines(fromSec: number, toSec: number, bpm: number, beats: number): GridLine[] {
  const step = secPerBeat(bpm) * beats
  if (!(step > 0) || !(toSec > fromSec)) return []
  const out: GridLine[] = []
  const first = Math.max(0, Math.ceil(fromSec / step - 1e-9))
  for (let n = first; ; n++) {
    const sec = n * step
    if (sec > toSec) break
    const beatsIn = n * beats
    out.push({
      sec,
      bar: Math.floor(beatsIn / BEATS_PER_BAR) + 1,
      beat: (beatsIn % BEATS_PER_BAR) + 1,
      onBar: Math.abs(beatsIn % BEATS_PER_BAR) < 1e-9
    })
  }
  return out
}

/** A line's label: the bar on its own, or bar.beat inside a bar. */
export function barLabel(line: GridLine): string {
  return line.onBar ? String(line.bar) : `${line.bar}.${line.beat}`
}

/** The nearest grid line to a moment. */
export function snapSec(sec: number, bpm: number, beats: number): number {
  if (!(bpm > 0)) return sec
  const step = secPerBeat(bpm) * beats
  if (!(step > 0)) return sec
  return Math.max(0, Math.round(sec / step) * step)
}

/** The nearest bar line to a moment, whatever division is being drawn. */
export function snapToBar(sec: number, bpm: number): number {
  return snapSec(sec, bpm, BEATS_PER_BAR)
}
