/**
 * Laying clips onto a lane.
 *
 * A clip is a window onto a source: `offsetSamples` is how far into that
 * source it starts and `durationSamples` is how much of it plays, both in
 * arrangement frames. Moving a clip changes where its window sits on the
 * timeline; trimming changes how much of the source the window shows. Neither
 * touches the audio, and two clips cut from one source stay two windows onto
 * that same source.
 *
 * A clip put down takes the room it needs. Anything already under it gives
 * way: covered clips go, part-covered clips are trimmed back, and a clip it
 * lands inside is left as two.
 */

/** The fields the placement maths reads. Clips carry plenty more. */
export interface Placed {
  id: string
  startSample: number
  durationSamples: number
  offsetSamples: number
  sourceDurationSamples: number
  /**
   * Position in ticks, which the timeline treats as authoritative and derives
   * `startSample` from. Anything that moves a clip has to drop it so the
   * timeline works the new position out again.
   */
  startTick?: number
}

/** Shortest a clip may be left, in frames. Below this it is not audible. */
export const MIN_CLIP_FRAMES = 64

/** One past the clip's last frame. */
export function endOf(clip: Placed): number {
  return clip.startSample + clip.durationSamples
}

/** The same clip, with the stale tick dropped so the timeline recomputes it. */
function retick<T extends Placed>(clip: T): T {
  const { startTick: _dropped, ...rest } = clip
  return rest as T
}

/** How much of the source sits behind and ahead of what a clip is showing. */
export function hiddenFrames(clip: Placed): { before: number; after: number } {
  const before = Math.max(0, clip.offsetSamples)
  const after = Math.max(0, clip.sourceDurationSamples - clip.offsetSamples - clip.durationSamples)
  return { before, after }
}

/**
 * The clip with one edge moved to `edgeSample`.
 *
 * The window slides over the source rather than stretching it: pulling the
 * left edge back reveals what sits before the clip, and pushing the right edge
 * out reveals what follows. Neither edge can pass the end of the source, and
 * the left edge cannot cross the start of the arrangement.
 */
export function trimTo<T extends Placed>(clip: T, boundary: 'left' | 'right', edgeSample: number): T {
  const hidden = hiddenFrames(clip)
  if (boundary === 'right') {
    const longest = clip.durationSamples + hidden.after
    const duration = Math.round(clamp(edgeSample - clip.startSample, MIN_CLIP_FRAMES, longest))
    return retick({ ...clip, durationSamples: duration })
  }
  // Moving the left edge moves the start and the offset together, so the audio
  // under the part that stays does not shift.
  const earliest = Math.max(0, clip.startSample - hidden.before)
  const latest = endOf(clip) - MIN_CLIP_FRAMES
  const start = Math.round(clamp(edgeSample, earliest, latest))
  const delta = start - clip.startSample
  return retick({
    ...clip,
    startSample: start,
    offsetSamples: clip.offsetSamples + delta,
    durationSamples: clip.durationSamples - delta
  })
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** The part of `clip` that runs before `at`, or null when none does. */
function head<T extends Placed>(clip: T, at: number): T | null {
  const duration = at - clip.startSample
  if (duration < MIN_CLIP_FRAMES) return null
  return retick({ ...clip, durationSamples: duration })
}

/** The part of `clip` that runs from `at`, or null when none does. */
function tail<T extends Placed>(clip: T, at: number, id: string): T | null {
  const duration = endOf(clip) - at
  if (duration < MIN_CLIP_FRAMES) return null
  const skipped = at - clip.startSample
  return retick({
    ...clip,
    id,
    startSample: at,
    offsetSamples: clip.offsetSamples + skipped,
    durationSamples: duration
  })
}

/**
 * `clips` after `incoming` is laid over them, in start order.
 *
 * `newId` names the piece left behind when `incoming` lands inside a clip and
 * leaves two.
 */
export function layOver<T extends Placed>(
  clips: readonly T[],
  incoming: T,
  newId: () => string
): T[] {
  const from = incoming.startSample
  const to = endOf(incoming)
  const out: T[] = []
  for (const clip of clips) {
    if (clip.id === incoming.id) continue
    if (endOf(clip) <= from || clip.startSample >= to) {
      out.push(clip)
      continue
    }
    const before = head(clip, from)
    const after = tail(clip, to, before ? newId() : clip.id)
    if (before) out.push(before)
    if (after) out.push(after)
  }
  out.push(retick(incoming))
  out.sort((a, b) => a.startSample - b.startSample || a.id.localeCompare(b.id))
  return out
}

/** `clips` after one of them is trimmed, with whatever it grows over giving way. */
export function trimWithin<T extends Placed>(
  clips: readonly T[],
  clipId: string,
  boundary: 'left' | 'right',
  edgeSample: number,
  newId: () => string
): T[] {
  const clip = clips.find((c) => c.id === clipId)
  if (!clip) return [...clips]
  return layOver(clips, trimTo(clip, boundary, edgeSample), newId)
}
