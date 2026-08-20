/**
 * Clips: the pieces an edit track is made of.
 *
 * A track row starts as one clip covering the whole file. Cutting it at the
 * playhead splits that clip in two, and from then on the row is a *timeline*
 * rather than a file: position along the row no longer equals position in the
 * source audio, because pieces can be removed or moved.
 *
 * Two clocks, and keeping them straight is the whole job here:
 *   - timeline seconds: where you are on the row
 *   - source seconds:   where that lands inside the original file
 *
 * Pure and dependency-free so the playback engine, the waveform renderer and
 * the tests can all share one definition.
 */

export interface Clip {
  id: string
  /** Where this piece starts on the row's timeline. */
  startSec: number
  /** How long it plays for. */
  durationSec: number
  /** Where inside the source file this piece begins. */
  sourceOffsetSec: number
}

/** Shortest clip we will create. Below this a cut is a mistake, not an edit. */
export const MIN_CLIP_SEC = 0.01

let clipSeq = 0

/** Ids only need to be unique within a session; clips are never persisted. */
export function makeClipId(): string {
  clipSeq += 1
  return `c${clipSeq}`
}

/** The single clip a freshly loaded track starts as. */
export function wholeTrackClip(durationSec: number): Clip {
  return { id: makeClipId(), startSec: 0, durationSec, sourceOffsetSec: 0 }
}

/** Timeline end of a clip. */
export function clipEnd(clip: Clip): number {
  return clip.startSec + clip.durationSec
}

/** Length of the row: the end of its last clip. Zero when empty. */
export function timelineDuration(clips: readonly Clip[]): number {
  let end = 0
  for (const clip of clips) {
    const e = clipEnd(clip)
    if (e > end) end = e
  }
  return end
}

/** Keep clips in timeline order; everything below assumes it. */
export function sortClips(clips: readonly Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.startSec - b.startSec)
}

/**
 * The clip covering `timelineSec`, or null when it falls in a gap.
 *
 * Clips are not expected to overlap. If they do — only reachable by moving one
 * on top of another — the earliest-starting one wins, so the result is at least
 * deterministic. Proper overlap handling, where a dropped clip trims the one
 * underneath the way a DAW does, is not built yet.
 */
export function clipAt(clips: readonly Clip[], timelineSec: number): Clip | null {
  let found: Clip | null = null
  for (const clip of clips) {
    if (timelineSec < clip.startSec || timelineSec >= clipEnd(clip)) continue
    if (!found || clip.startSec < found.startSec) found = clip
  }
  return found
}

/**
 * Source position for a timeline position, or null in a gap.
 *
 * This is the conversion the waveform renderer and the playback engine both
 * need, and the reason clips exist as a shared module rather than as UI state.
 */
export function sourceTimeAt(clips: readonly Clip[], timelineSec: number): number | null {
  const clip = clipAt(clips, timelineSec)
  if (!clip) return null
  return clip.sourceOffsetSec + (timelineSec - clip.startSec)
}

export interface SplitResult {
  clips: Clip[]
  /** The two halves, or null when nothing was cut. */
  left: Clip | null
  right: Clip | null
  /** Why a cut did nothing, for the UI to report rather than failing silently. */
  reason?: 'gap' | 'too-short'
}

/**
 * Cut the clip under the playhead in two.
 *
 * A cut exactly on a clip boundary, or one that would leave a sliver shorter
 * than {@link MIN_CLIP_SEC}, is refused rather than producing a clip too small
 * to grab. The clips array is returned unchanged in that case.
 */
export function splitAt(clips: readonly Clip[], timelineSec: number): SplitResult {
  const target = clipAt(clips, timelineSec)
  if (!target) return { clips: [...clips], left: null, right: null, reason: 'gap' }

  const leftLen = timelineSec - target.startSec
  const rightLen = target.durationSec - leftLen
  if (leftLen < MIN_CLIP_SEC || rightLen < MIN_CLIP_SEC) {
    return { clips: [...clips], left: null, right: null, reason: 'too-short' }
  }

  const left: Clip = { ...target, durationSec: leftLen }
  const right: Clip = {
    id: makeClipId(),
    startSec: timelineSec,
    durationSec: rightLen,
    sourceOffsetSec: target.sourceOffsetSec + leftLen
  }

  const out: Clip[] = []
  for (const clip of clips) {
    if (clip.id === target.id) out.push(left, right)
    else out.push(clip)
  }
  return { clips: sortClips(out), left, right }
}

/**
 * Remove a clip, leaving a gap where it was.
 *
 * A gap plays as silence. That matches what a DAW does on delete, and keeps
 * everything after it where the user put it.
 */
export function removeClip(clips: readonly Clip[], id: string): Clip[] {
  return clips.filter((clip) => clip.id !== id)
}

/**
 * Remove a clip and pull everything after it back by its length, closing the
 * gap. This is a ripple delete, and it is what you want when trimming an intro
 * out of a track rather than punching a hole in it.
 */
export function rippleRemoveClip(clips: readonly Clip[], id: string): Clip[] {
  const target = clips.find((clip) => clip.id === id)
  if (!target) return [...clips]
  const out: Clip[] = []
  for (const clip of clips) {
    if (clip.id === id) continue
    out.push(
      clip.startSec >= clipEnd(target)
        ? { ...clip, startSec: clip.startSec - target.durationSec }
        : clip
    )
  }
  return sortClips(out)
}

/**
 * Move a clip and let it overwrite whatever it lands on.
 *
 * This is what a DAW does when you drop a clip on top of another: the one
 * underneath gives way. Without it, dragging would silently create overlaps,
 * and an overlap has no honest answer for "what plays here".
 *
 * Four ways a neighbour can be hit, and all four have to be handled or a drag
 * quietly corrupts the timeline:
 *   - fully covered            -> it goes
 *   - clipped on its right end -> shortened
 *   - clipped on its left end  -> shortened, and its source offset moves with
 *                                 it, or the audio inside would slide
 *   - straddled in the middle  -> split into the surviving ends
 */
export function placeClip(clips: readonly Clip[], id: string, toStartSec: number): Clip[] {
  const moving = clips.find((clip) => clip.id === id)
  if (!moving) return [...clips]

  const start = Math.max(0, toStartSec)
  const moved: Clip = { ...moving, startSec: start }
  const end = clipEnd(moved)

  const out: Clip[] = [moved]
  for (const clip of clips) {
    if (clip.id === id) continue
    const otherEnd = clipEnd(clip)

    // Untouched: entirely before or entirely after.
    if (otherEnd <= start || clip.startSec >= end) {
      out.push(clip)
      continue
    }
    // Fully covered.
    if (clip.startSec >= start && otherEnd <= end) continue

    // Straddled: the mover sits inside it, so it survives as two ends.
    if (clip.startSec < start && otherEnd > end) {
      out.push({ ...clip, durationSec: start - clip.startSec })
      out.push({
        id: makeClipId(),
        startSec: end,
        durationSec: otherEnd - end,
        sourceOffsetSec: clip.sourceOffsetSec + (end - clip.startSec)
      })
      continue
    }
    // Clipped on the right.
    if (clip.startSec < start) {
      out.push({ ...clip, durationSec: start - clip.startSec })
      continue
    }
    // Clipped on the left: the source offset has to move by the same amount,
    // or the audio inside the clip slides relative to its new start.
    const trimmed = end - clip.startSec
    out.push({
      ...clip,
      startSec: end,
      durationSec: otherEnd - end,
      sourceOffsetSec: clip.sourceOffsetSec + trimmed
    })
  }

  return sortClips(out.filter((clip) => clip.durationSec > MIN_CLIP_SEC / 2))
}

/** Move a clip along the timeline. Negative positions are clamped to zero. */
export function moveClip(clips: readonly Clip[], id: string, toStartSec: number): Clip[] {
  return sortClips(
    clips.map((clip) =>
      clip.id === id ? { ...clip, startSec: Math.max(0, toStartSec) } : clip
    )
  )
}

/**
 * Playable regions in source order, for the audio engine.
 *
 * Zero-length clips are dropped so the engine never has to reason about them.
 */
export interface Region {
  startSec: number
  durationSec: number
  sourceOffsetSec: number
}

export function toRegions(clips: readonly Clip[]): Region[] {
  return sortClips(clips)
    .filter((clip) => clip.durationSec > 0)
    .map((clip) => ({
      startSec: clip.startSec,
      durationSec: clip.durationSec,
      sourceOffsetSec: clip.sourceOffsetSec
    }))
}
