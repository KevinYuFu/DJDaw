/**
 * Clips on an arrangement timeline.
 *
 * Unlike a deck row, which is one file cut into pieces laid end to end, an
 * arrangement track is a strip of time that clips sit on: there can be silence
 * between them, they can come from different files, and moving one leaves a
 * space rather than shuffling its neighbours along.
 *
 * Every clip plays at whatever speed makes its own beat grid match the
 * arrangement's, so a 174 file on a 150 arrangement plays at 150 and its bars
 * fall on the arrangement's bars. `rate` is that speed, and it is the reason
 * timeline seconds and file seconds are not the same thing here.
 *
 * A clip is a window onto its file. Dragging its edge moves that window, so
 * pulling an edge outward gives back audio an earlier drag trimmed off, and
 * pulling it inward hides audio without losing it.
 */

/** How many tracks an arrangement can hold. */
export const MAX_TRACKS = 6

/** How many an empty arrangement starts with. */
export const START_TRACKS = 2

/** Shortest a clip can be dragged, in timeline seconds. */
export const MIN_CLIP_SEC = 0.02

export interface ArrangementClip {
  id: string
  /** Where it starts on the shared timeline. */
  startSec: number
  /** How long it runs on the timeline, which is file seconds divided by rate. */
  durationSec: number
  /** Where inside the file it starts playing, in file seconds. */
  sourceOffsetSec: number
  /** The file it plays. */
  sourceId: string
  /** How long that file is, so an edge cannot be dragged past the end of it. */
  sourceDurationSec: number
  /** File seconds per timeline second, so its grid matches the arrangement's. */
  rate: number
}

/** How fast a file has to play for its grid to match the arrangement's. */
export function rateFor(fileBpm: number, arrangementBpm: number): number {
  if (!(fileBpm > 0) || !(arrangementBpm > 0)) return 1
  return fileBpm / arrangementBpm
}

/** File seconds turned into the timeline seconds they take up. */
export function toTimelineSec(fileSec: number, rate: number): number {
  return rate > 0 ? fileSec / rate : fileSec
}

/** Timeline end of a clip. */
export function endSec(clip: ArrangementClip): number {
  return clip.startSec + clip.durationSec
}

/** How much of the file is left after where a clip stops reading. */
function tailSec(clip: ArrangementClip): number {
  return Math.max(0, clip.sourceDurationSec - clip.sourceOffsetSec - clip.durationSec * clip.rate)
}

/** In timeline order. */
export function sortClips(clips: readonly ArrangementClip[]): ArrangementClip[] {
  return [...clips].sort((a, b) => a.startSec - b.startSec)
}

/** The clip covering a moment, or null for the silence between them. */
export function clipAt(
  clips: readonly ArrangementClip[],
  timelineSec: number
): ArrangementClip | null {
  for (const clip of clips) {
    if (timelineSec >= clip.startSec && timelineSec < endSec(clip)) return clip
  }
  return null
}

/** How far the track runs, which is the end of its last clip. */
export function trackDuration(clips: readonly ArrangementClip[]): number {
  let end = 0
  for (const clip of clips) end = Math.max(end, endSec(clip))
  return end
}

function neighbourBefore(
  clips: readonly ArrangementClip[],
  clip: ArrangementClip
): ArrangementClip | null {
  let best: ArrangementClip | null = null
  for (const other of clips) {
    if (other.id === clip.id) continue
    if (endSec(other) <= clip.startSec && (!best || endSec(other) > endSec(best))) best = other
  }
  return best
}

function neighbourAfter(
  clips: readonly ArrangementClip[],
  clip: ArrangementClip
): ArrangementClip | null {
  let best: ArrangementClip | null = null
  for (const other of clips) {
    if (other.id === clip.id) continue
    if (other.startSec >= endSec(clip) && (!best || other.startSec < best.startSec)) best = other
  }
  return best
}

/** Where a clip's left edge can be dragged to, as [earliest, latest]. */
export function startEdgeRange(
  clips: readonly ArrangementClip[],
  clip: ArrangementClip
): [number, number] {
  // Back as far as the file has audio before this point, and no further than
  // the clip that comes before it.
  const before = neighbourBefore(clips, clip)
  const room = Math.min(toTimelineSec(clip.sourceOffsetSec, clip.rate), clip.startSec)
  const earliest = Math.max(clip.startSec - room, before ? endSec(before) : 0)
  return [earliest, endSec(clip) - MIN_CLIP_SEC]
}

/** Where a clip's right edge can be dragged to, as [earliest, latest]. */
export function endEdgeRange(
  clips: readonly ArrangementClip[],
  clip: ArrangementClip
): [number, number] {
  const after = neighbourAfter(clips, clip)
  const room = endSec(clip) + toTimelineSec(tailSec(clip), clip.rate)
  const latest = Math.min(room, after ? after.startSec : Number.POSITIVE_INFINITY)
  return [clip.startSec + MIN_CLIP_SEC, latest]
}

/**
 * Drag a clip's left edge to a moment on the timeline.
 *
 * The clip keeps playing the same audio at the same place on the timeline, so
 * moving this edge changes where in the file it starts as well as how long it
 * is: dragging it left gives back audio that was trimmed off the front.
 */
export function dragStartEdge(
  clips: readonly ArrangementClip[],
  id: string,
  toSec: number
): ArrangementClip[] {
  const clip = clips.find((c) => c.id === id)
  if (!clip) return [...clips]
  const [earliest, latest] = startEdgeRange(clips, clip)
  const at = Math.min(Math.max(toSec, earliest), latest)
  const shift = at - clip.startSec
  return clips.map((c) =>
    c.id === id
      ? {
          ...c,
          startSec: at,
          durationSec: c.durationSec - shift,
          sourceOffsetSec: Math.max(0, c.sourceOffsetSec + shift * c.rate)
        }
      : c
  )
}

/**
 * Drag a clip's right edge to a moment on the timeline.
 *
 * Only its length changes: where it starts, and where in the file it starts,
 * both stay put.
 */
export function dragEndEdge(
  clips: readonly ArrangementClip[],
  id: string,
  toSec: number
): ArrangementClip[] {
  const clip = clips.find((c) => c.id === id)
  if (!clip) return [...clips]
  const [earliest, latest] = endEdgeRange(clips, clip)
  const at = Math.min(Math.max(toSec, earliest), latest)
  return clips.map((c) => (c.id === id ? { ...c, durationSec: at - c.startSec } : c))
}

/**
 * Move a clip along its track, into whatever room there is.
 *
 * It stops flush against its neighbours rather than pushing them along or
 * trimming them: an arrangement is clips at places, not a queue.
 */
export function moveClip(
  clips: readonly ArrangementClip[],
  id: string,
  toSec: number
): ArrangementClip[] {
  const clip = clips.find((c) => c.id === id)
  if (!clip) return [...clips]
  const before = neighbourBefore(clips, clip)
  const after = neighbourAfter(clips, clip)
  const earliest = before ? endSec(before) : 0
  const latest = after ? after.startSec - clip.durationSec : Number.POSITIVE_INFINITY
  const at = Math.min(Math.max(toSec, earliest), Math.max(earliest, latest))
  return clips.map((c) => (c.id === id ? { ...c, startSec: at } : c))
}

/** Whether a clip would sit clear of every other one at a given place. */
export function fits(
  clips: readonly ArrangementClip[],
  id: string,
  startSec: number,
  durationSec: number
): boolean {
  if (startSec < 0) return false
  const end = startSec + durationSec
  for (const other of clips) {
    if (other.id === id) continue
    if (startSec < endSec(other) && end > other.startSec) return false
  }
  return true
}

/** One region for the engine, in the voice's own stretched timeline. */
export interface VoiceRegion {
  startSec: number
  durationSec: number
  sourceOffsetSec: number
}

/**
 * What one file plays on one track, as regions the engine can follow.
 *
 * A voice plays only its own file's clips and silence for every other moment.
 * The engine walks its timeline at the voice's rate, so every time here is the
 * arrangement's time multiplied by that rate — which is what makes a clip read
 * its file faster or slower while staying where it is on screen.
 *
 * The tail is a region that reads from past the end of the file, which is
 * silence: without it the engine takes the last clip for the end of the
 * timeline and refuses to put the playhead anywhere after it.
 */
export function voiceRegions(
  clips: readonly ArrangementClip[],
  sourceId: string,
  timelineSec: number,
  rate: number
): VoiceRegion[] {
  const scale = rate > 0 ? rate : 1
  const mine = sortClips(clips.filter((c) => c.sourceId === sourceId && c.durationSec > 0))
  const out: VoiceRegion[] = mine.map((c) => ({
    startSec: c.startSec * scale,
    durationSec: c.durationSec * scale,
    sourceOffsetSec: c.sourceOffsetSec
  }))
  const last = out.length > 0 ? out[out.length - 1] : null
  const from = last ? last.startSec + last.durationSec : 0
  const end = timelineSec * scale
  if (end > from) {
    const past = mine.length > 0 ? mine[0].sourceDurationSec : 0
    out.push({ startSec: from, durationSec: end - from, sourceOffsetSec: past + 1 })
  }
  return out
}

let nextClipId = 0

export function makeArrangementClipId(): string {
  nextClipId += 1
  return `ac${nextClipId}`
}

/** Put a track at a place in the stack. */
export function moveTrackTo(ids: readonly string[], id: string, index: number): string[] {
  const from = ids.indexOf(id)
  if (from < 0) return [...ids]
  const rest = ids.filter((other) => other !== id)
  const to = Math.max(0, Math.min(rest.length, index))
  rest.splice(to, 0, id)
  return rest
}

/** The track that takes the selection when one is deleted. */
export function selectAfterRemoving(ids: readonly string[], id: string): string | null {
  const at = ids.indexOf(id)
  if (at < 0) return null
  const rest = ids.filter((other) => other !== id)
  if (rest.length === 0) return null
  return rest[Math.min(at, rest.length - 1)]
}
