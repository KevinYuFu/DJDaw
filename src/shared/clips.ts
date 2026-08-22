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
  /**
   * Which audio this piece plays. Left off, it is the row's own track.
   *
   * A piece dragged from one row to another keeps this, so it goes on playing
   * what it always played: a row is an arrangement of samples rather than a
   * window onto one file.
   */
  sourceId?: string
  /**
   * A hole in the row: it takes up time and plays nothing.
   *
   * Deleting a piece from the middle of a row leaves one of these rather than
   * closing the row up, because the pieces after it were placed against the
   * ones before and pulling them earlier is rarely what was meant. It is a
   * piece like any other — it can be selected, reordered and deleted — and
   * deleting it is what closes the row up.
   */
  silent?: boolean
  /**
   * Switched off: it keeps its place on the row and plays nothing.
   *
   * Unlike a hole it still holds audio and is drawn, greyed out, so it can be
   * switched back on. Muting a piece to hear the row without it is the point.
   */
  disabled?: boolean
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
 * own index and nothing moves. The comparison is against each remaining
 * piece's middle, so a piece has to be dragged past half of its neighbour
 * before they trade places rather than flickering at the first pixel.
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
 * Where a piece dropped at `startSec` would actually come to rest.
 *
 * The drop is a reordering, so a piece does not land under the pointer — it
 * lands at the place in the order the pointer picked out. The ghost has to
 * show that, or a drag against a long neighbour promises a move that will not
 * happen and the row looks broken when it does not.
 */
export function dropStartSec(clips: readonly Clip[], id: string, startSec: number): number {
  const to = dropIndex(clips, id, startSec)
  const rest = clips.filter((clip) => clip.id !== id)
  let at = 0
  for (let i = 0; i < to && i < rest.length; i++) at += rest[i].durationSec
  return at
}

/**
 * Move a piece to a new place in the order. The rest close up behind it and
 * open up in front of it; nothing is overwritten and nothing is trimmed.
 */
/** Put a piece into a row at a place in its order. */
export function insertClip(clips: readonly Clip[], index: number, clip: Clip): Clip[] {
  const at = Math.max(0, Math.min(clips.length, index))
  const out = clips.slice()
  out.splice(at, 0, clip)
  return layOut(out)
}

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

/**
 * How much of a hole is left in front of a piece dropped at `atSec`.
 *
 * A placement that would leave a sliver of a hole is nudged flush to that
 * edge. Negative when the piece is longer than the hole.
 */
function leadInHole(hole: Clip, atSec: number, durationSec: number): number {
  const room = hole.durationSec - durationSec
  if (room < 0) return -1
  const lead = Math.max(0, Math.min(room, atSec - hole.startSec))
  if (lead < MIN_CLIP_SEC) return 0
  if (room - lead < MIN_CLIP_SEC) return room
  return lead
}

/**
 * Drop a piece into a hole, keeping whatever time is left either side of it.
 *
 * A hole is empty room, so a piece dropped on one lands where it was let go
 * rather than between two neighbours. The hole is cut around it and the row
 * stays exactly as long as it was.
 *
 * Null when the piece is longer than the hole, which the caller takes as
 * "this does not fit here".
 */
export function fillHole(
  clips: readonly Clip[],
  holeId: string,
  atSec: number,
  incoming: Clip
): Clip[] | null {
  const at = clips.findIndex((clip) => clip.id === holeId)
  const hole = clips[at]
  if (!hole || !hole.silent) return null
  const lead = leadInHole(hole, atSec, incoming.durationSec)
  if (lead < 0) return null
  const trail = hole.durationSec - incoming.durationSec - lead

  const pieces: Clip[] = []
  if (lead > 0) pieces.push({ ...hole, durationSec: lead })
  pieces.push(incoming)
  if (trail > 0) pieces.push({ ...hole, id: makeClipId(), durationSec: trail })
  return layOut([...clips.slice(0, at), ...pieces, ...clips.slice(at + 1)])
}

/** Where a piece dropped at `atSec` would start inside a hole. */
export function fillStartSec(hole: Clip, atSec: number, durationSec: number): number {
  const lead = leadInHole(hole, atSec, durationSec)
  return hole.startSec + Math.max(0, lead)
}

/** The single clip a freshly loaded track starts as. */
export function wholeTrackClip(durationSec: number, sourceId?: string): Clip {
  return {
    id: makeClipId(),
    startSec: 0,
    durationSec,
    sourceOffsetSec: 0,
    sourceId
  }
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
 * Zero-length clips are dropped so the engine never has to reason about them,
 * and so are holes and switched-off pieces: the row plays nothing for the time
 * they take up.
 */
export interface Region {
  /** Which audio to read. Left off, the row's own track. */
  sourceId?: string
  startSec: number
  durationSec: number
  sourceOffsetSec: number
}

export function toRegions(clips: readonly Clip[]): Region[] {
  return sortClips(clips)
    .filter((clip) => clip.durationSec > 0 && !clip.silent && !clip.disabled)
    .map((clip) => ({
      startSec: clip.startSec,
      durationSec: clip.durationSec,
      sourceOffsetSec: clip.sourceOffsetSec,
      sourceId: clip.sourceId
    }))
}
