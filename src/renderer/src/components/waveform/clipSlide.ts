import type { Clip } from '@shared/clips'

/**
 * The slide a row does when its pieces change places.
 *
 * Reordering is instant in the store — the audio has to be right on the next
 * buffer — so the movement is drawn rather than modelled: the row remembers
 * where each piece used to be and walks it to where it is now. Without it a
 * piece and its neighbour trade places between two frames and there is nothing
 * to say which one moved.
 */

/**
 * How long a piece takes to reach its new place, in ms.
 *
 * The one number for every movement a row makes — reordering, closing a hole,
 * losing an end. Slow enough to be watched: an edit that happens between two
 * frames leaves nobody any wiser about what it did.
 */
export const SLIDE_MS = 260

export interface Slide {
  /** Where each piece was before the change. */
  from: Map<string, number>
  startedAt: number
}

/**
 * A slide to run, or null when there is nothing to watch.
 *
 * Anything that only moves pieces the row already had slides: trading two of
 * them over, closing a hole, losing the piece off one end. Anything that brings
 * a piece the row did not have does not — a cut, a fresh track, or the hole a
 * delete leaves behind are all new pieces, and sliding those would be shapes
 * flying in from nowhere.
 */
export function beginSlide(
  before: readonly Clip[],
  after: readonly Clip[],
  now: number
): Slide | null {
  if (before.length === 0 || after.length === 0) return null
  const from = new Map<string, number>()
  for (const clip of before) from.set(clip.id, clip.startSec)
  let moved = false
  for (const clip of after) {
    const was = from.get(clip.id)
    if (was === undefined) return null
    if (was !== clip.startSec) moved = true
  }
  return moved ? { from, startedAt: now } : null
}

/**
 * The row as it looks with room opened at `index` for a piece `gapSec` long.
 *
 * What a row shows while a piece from somewhere else is held over it. Only
 * `startSec` moves and no piece is added, so the slide animates it like any
 * other rearrangement and the store is left alone until the drop.
 */
export function openGap(clips: readonly Clip[], index: number, gapSec: number): readonly Clip[] {
  if (!(gapSec > 0)) return clips
  // Room at the very end has nothing to push aside, so the row is unchanged.
  const at = Math.max(0, Math.min(clips.length, index))
  if (at >= clips.length) return clips
  return clips.map((clip, i) => (i < at ? clip : { ...clip, startSec: clip.startSec + gapSec }))
}

/** Ease out: quick to leave, gentle to arrive. */
function ease(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/**
 * The row part-way through a slide, and whether it has arrived.
 *
 * Only `startSec` moves. A piece's length and the audio it plays are settled
 * the moment the drop commits; this is the eye catching up.
 */
export function slideClips(
  clips: readonly Clip[],
  slide: Slide,
  now: number
): { clips: Clip[]; done: boolean } {
  const t = Math.min(1, Math.max(0, (now - slide.startedAt) / SLIDE_MS))
  if (t >= 1) return { clips: clips.slice(), done: true }
  const k = ease(t)
  return {
    clips: clips.map((clip) => {
      const was = slide.from.get(clip.id)
      if (was === undefined || was === clip.startSec) return clip
      return { ...clip, startSec: was + (clip.startSec - was) * k }
    }),
    done: false
  }
}
