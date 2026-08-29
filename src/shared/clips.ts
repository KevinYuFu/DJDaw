/**
 * Clips: the pieces an edit track is made of.
 *
 * A track row starts as one clip covering the whole file. Cutting it at the
 * playhead splits that clip in two, and from then on the row is a *timeline*:
 * position along the row no longer equals position in the source audio.
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
  /**
   * A hole in the row: it takes up time and plays nothing.
   *
   * Deleting a piece from the middle of a row leaves one of these, holding the
   * pieces after it in place. It is a piece like any other — selectable,
   * reorderable, deletable — and deleting it closes the row up.
   */
  silent?: boolean
}

/**
 * Lay pieces end to end in the order given.
 *
 * A row is its pieces in an order, not a set of pieces at positions. Every
 * operation that changes the order returns to this, so a row can never end up
 * with two pieces over each other or an accidental hole between them — the
 * only holes are the ones that say they are holes.
 */
export function layOut(clips: readonly Clip[]): Clip[] {
  let at = 0
  return clips.map((clip) => {
    const placed = clip.startSec === at ? clip : { ...clip, startSec: at }
    at += clip.durationSec
    return placed
  })
}

/** Index of the piece covering `timelineSec`, or -1. */
export function segmentIndexAt(clips: readonly Clip[], timelineSec: number): number {
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    if (timelineSec >= clip.startSec && timelineSec < clip.startSec + clip.durationSec) return i
  }
  return -1
}

/**
 * Where a piece dropped at `startSec` belongs in the order.
 *
 * Measured against the row with the piece taken out, so the answer is an index
 * into that shorter list: dropping a piece where it already is gives back its
 * own index. The comparison is against each remaining piece's middle, so a
 * piece trades places once it is dragged past half of its neighbour.
 */
export function dropIndex(clips: readonly Clip[], id: string, startSec: number): number {
  const rest = clips.filter((clip) => clip.id !== id)
  let at = 0
  for (let i = 0; i < rest.length; i++) {
    const middle = at + rest[i].durationSec / 2
    if (startSec < middle) return i
    at += rest[i].durationSec
  }
  return rest.length
}


/**
 * Move a piece to a new place in the order. The rest close up behind it and
 * open up in front of it; nothing is overwritten and nothing is trimmed.
 */
export function reorderClip(clips: readonly Clip[], id: string, toIndex: number): Clip[] {
  const from = clips.findIndex((clip) => clip.id === id)
  if (from < 0) return clips.slice()
  const rest = clips.filter((clip) => clip.id !== id)
  const to = Math.max(0, Math.min(rest.length, toIndex))
  rest.splice(to, 0, clips[from])
  return layOut(rest)
}

/** What a delete did, and what should be selected afterwards. */
export interface DeleteResult {
  clips: Clip[]
  /** The hole left behind, so it can be selected and deleted again to close up. */
  selectId: string | null
}

/**
 * Delete a piece.
 *
 * From the middle of a row this leaves a hole of the same length, and hands
 * back its id so it can be selected: deleting again removes the hole and the
 * row closes up. At either end there is nothing to hold apart, so the piece
 * simply goes and the row shortens.
 *
 * Deleting a hole always closes the row up. That is the only thing a hole is
 * for.
 */
export function deleteSegment(clips: readonly Clip[], id: string): DeleteResult {
  const index = clips.findIndex((clip) => clip.id === id)
  if (index < 0) return { clips: clips.slice(), selectId: null }

  const target = clips[index]
  const atEdge = index === 0 || index === clips.length - 1
  if (target.silent || atEdge) {
    return { clips: layOut(clips.filter((clip) => clip.id !== id)), selectId: null }
  }

  const hole: Clip = {
    id: makeClipId(),
    startSec: target.startSec,
    durationSec: target.durationSec,
    sourceOffsetSec: 0,
    silent: true
  }
  const next = clips.slice()
  next[index] = hole
  return { clips: layOut(next), selectId: hole.id }
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
 * The conversion the waveform renderer and the playback engine both use.
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
  /** Why a cut did nothing, for the UI to report. */
  reason?: 'gap' | 'too-short'
}

/**
 * Cut the clip under the playhead in two.
 *
 * A cut exactly on a clip boundary, or one leaving a sliver shorter than
 * {@link MIN_CLIP_SEC}, is refused and the clips array returned unchanged.
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
 * gap. A ripple delete: use it to trim a section out of a track.
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
    .filter((clip) => clip.durationSec > 0 && !clip.silent)
    .map((clip) => ({
      startSec: clip.startSec,
      durationSec: clip.durationSec,
      sourceOffsetSec: clip.sourceOffsetSec
    }))
}
