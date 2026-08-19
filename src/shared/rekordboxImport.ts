/**
 * Convert a parsed rekordbox collection into DJDaw tracks.
 *
 * Kept separate from the XML scanning so the interesting part — grid phase,
 * cue mapping, loop lengths — is pure and testable without any XML at all.
 */

import type { BeatGrid, BeatGridAnchor, HotCue, MemoryCue, Track, TrackSource } from './types'
import type { RekordboxTrack } from './rekordboxXml'
import { localIdFor, rekordboxIdFor } from './collection'

/** Fallback pad colours, mirroring HOT_CUE_COLORS in core/constants.ts. */
export const DEFAULT_HOT_CUE_COLORS = [
  '#00a0e9',
  '#7ac943',
  '#fff100',
  '#f5a11c',
  '#ea5532',
  '#e4007f',
  '#8f57a0',
  '#00a99d'
] as const

export const MAX_HOT_CUES = 8
/** rekordbox POSITION_MARK Type for a loop. */
const MARK_TYPE_LOOP = 4

/**
 * Build a DJDaw beat grid from rekordbox TEMPO markers.
 *
 * The models differ in one way that matters: DJDaw anchors beat 0 on a
 * downbeat, while a rekordbox marker can sit on any beat of the bar and says
 * which via `Battito`. So the first marker is walked back to its bar line;
 * otherwise every bar number in the app would be off and `beatInBar` would
 * report the wrong thing.
 */
export function gridFromTempos(rb: RekordboxTrack): BeatGrid | null {
  const tempos = [...rb.tempos].filter((t) => t.bpm > 0).sort((a, b) => a.inizio - b.inizio)
  if (tempos.length === 0) return null

  const first = tempos[0]
  const beatsPerBar = first.beatsPerBar || 4
  const secPerBeat = 60 / first.bpm
  let downbeat = first.inizio - (first.battito - 1) * secPerBeat

  // Walking back can land before the start of the file. Step forward whole
  // bars — which keeps it a downbeat — but never past the next tempo section.
  const nextTime = tempos.length > 1 ? tempos[1].inizio : Infinity
  const barSec = beatsPerBar * secPerBeat
  while (downbeat < 0 && downbeat + barSec < nextTime) downbeat += barSec

  const anchors: BeatGridAnchor[] = [{ time: downbeat, bpm: first.bpm }]
  for (let i = 1; i < tempos.length; i++) {
    anchors.push({ time: tempos[i].inizio, bpm: tempos[i].bpm })
  }
  return { anchors, beatsPerBar }
}

/** Seconds per beat at `time`, for turning a loop's length into beats. */
function secPerBeatAt(grid: BeatGrid | null, time: number, fallbackBpm: number | null): number {
  if (grid && grid.anchors.length) {
    let bpm = grid.anchors[0].bpm
    for (const a of grid.anchors) {
      if (a.time <= time) bpm = a.bpm
      else break
    }
    if (bpm > 0) return 60 / bpm
  }
  return fallbackBpm && fallbackBpm > 0 ? 60 / fallbackBpm : 0.5
}

export interface ConvertedCues {
  hotCues: HotCue[]
  memoryCues: MemoryCue[]
  cuePoint: number | null
}

/**
 * Split rekordbox POSITION_MARKs into hot cues and memory cues.
 *
 * `Num` carries the distinction: -1 is a memory cue, 0-7 are pads A-H. The
 * earliest memory cue is promoted to the deck's CUE point, which is what a CDJ
 * loads a track at, and is left out of the memory list so it is not drawn twice.
 */
export function cuesFromMarks(rb: RekordboxTrack, grid: BeatGrid | null): ConvertedCues {
  const hotCues: HotCue[] = []
  const memories: MemoryCue[] = []
  const seenPads = new Set<number>()

  for (const mark of rb.marks) {
    if (mark.num >= 0 && mark.num < MAX_HOT_CUES) {
      // rekordbox should not emit two marks for one pad, but a hand-edited
      // file can; the first one wins rather than the last.
      if (seenPads.has(mark.num)) continue
      seenPads.add(mark.num)

      const isLoop = mark.type === MARK_TYPE_LOOP && mark.end !== null && mark.end > mark.start
      const cue: HotCue = {
        index: mark.num,
        time: mark.start,
        color: mark.color ?? DEFAULT_HOT_CUE_COLORS[mark.num % DEFAULT_HOT_CUE_COLORS.length],
        type: isLoop ? 'loop' : 'cue'
      }
      if (mark.name) cue.name = mark.name
      if (isLoop && mark.end !== null) {
        const beats = (mark.end - mark.start) / secPerBeatAt(grid, mark.start, rb.averageBpm)
        // Snap to a musical length; rekordbox loop ends carry rounding noise.
        cue.loopBeats = beats > 0 ? Math.max(1, Math.round(beats * 4) / 4) : 1
      }
      hotCues.push(cue)
    } else if (mark.num === -1) {
      memories.push({ time: mark.start, ...(mark.name ? { name: mark.name } : {}) })
    }
  }

  hotCues.sort((a, b) => a.index - b.index)
  memories.sort((a, b) => a.time - b.time)

  const cuePoint = memories.length ? memories[0].time : null
  return { hotCues, memoryCues: memories.slice(1), cuePoint }
}

/**
 * Build a DJDaw {@link Track}.
 *
 * `audioKey` is the hash of the resolved path, which only the main process can
 * compute. The id is derived from it and from `source`, so the same file can
 * exist once in the rekordbox mirror and once as a local fork.
 */
export function trackFromRekordbox(
  rb: RekordboxTrack,
  audioKey: string,
  source: TrackSource = 'local'
): Track {
  const grid = gridFromTempos(rb)
  const { hotCues, memoryCues, cuePoint } = cuesFromMarks(rb, grid)
  const bpm = rb.averageBpm ?? (grid ? grid.anchors[0].bpm : null)

  return {
    id: source === 'rekordbox' ? rekordboxIdFor(audioKey) : localIdFor(audioKey),
    source,
    audioKey,
    path: rb.path,
    title: rb.name || rb.path.split('/').pop() || 'Untitled',
    artist: rb.artist || 'Unknown Artist',
    album: rb.album,
    genre: rb.genre,
    comment: rb.comments,
    durationSec: rb.totalTimeSec,
    sampleRate: rb.sampleRate,
    // The XML does not state the channel count; every deck decodes the real
    // file before playing, so this is only a placeholder for the browser.
    channels: 2,
    bpm,
    key: rb.tonality || null,
    grid,
    hotCues,
    memoryCues,
    cuePoint,
    rating: rb.rating,
    color: rb.colour,
    dateAdded: rb.dateAdded,
    // A grid from rekordbox is a real analysis, so the deck must not throw it
    // away and re-detect. The waveform is still generated on first load.
    analyzed: grid !== null,
    artwork: null
  }
}

/**
 * Merge an incoming track over one already in the collection.
 *
 * Used by every import path, file-by-file or rekordbox XML, so there is one
 * merge policy rather than two that drift apart. Metadata from the import
 * always wins, because that is the library the user curates. Grid and cues only
 * fill in where DJDaw has none, so analysis or hand-editing done here is never
 * destroyed by a re-import.
 */
export function mergeImported(existing: Track, imported: Track): Track {
  const keepGrid = existing.grid !== null
  const keepCues = existing.hotCues.length > 0 || existing.cuePoint !== null
  return {
    ...existing,
    path: imported.path || existing.path,
    title: imported.title,
    artist: imported.artist,
    album: imported.album,
    genre: imported.genre,
    comment: imported.comment,
    durationSec: imported.durationSec || existing.durationSec,
    sampleRate: imported.sampleRate || existing.sampleRate,
    channels: imported.channels || existing.channels,
    artwork: imported.artwork ?? existing.artwork,
    key: imported.key ?? existing.key,
    rating: imported.rating || existing.rating,
    color: imported.color ?? existing.color,
    grid: keepGrid ? existing.grid : imported.grid,
    bpm: keepGrid ? existing.bpm : (imported.bpm ?? existing.bpm),
    analyzed: existing.analyzed || imported.analyzed,
    hotCues: keepCues ? existing.hotCues : imported.hotCues,
    memoryCues: keepCues ? existing.memoryCues : imported.memoryCues,
    cuePoint: keepCues ? existing.cuePoint : imported.cuePoint
  }
}
