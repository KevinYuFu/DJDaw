import { create } from 'zustand'
import { createClip, type ClipTrack } from '@waveform-playlist/core'
import { PlaylistEngine } from '@waveform-playlist/engine'
import { type ChannelEq, type EqMode, flatChannel } from '@shared/eq'
import type { Track, WaveformData } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { ArrangementEngine } from '@renderer/audio/ArrangementEngine'
import { decodeTrack } from '@renderer/audio/decode'
import { playbackRate } from '@renderer/analysis/playbackRate'
import { layOver, trimWithin, type Placed } from '@renderer/arrangement/laneEdit'
import { nameLane } from '@renderer/arrangement/laneTitle'
import { STEM_NAMES, type StemName } from '@shared/stems'

/** The id a stem's audio is held under: the track it came from, and which part. */
export function stemSourceId(trackId: string, stem: StemName): string {
  return `${trackId}::${stem}`
}
import { placeClip } from '@renderer/arrangement/placement'
import { peekWaveform, resolveWaveform } from '@renderer/analysis/waveformCache'
import { WorkletPlayout, type ArrangementClip } from '@renderer/arrangement/WorkletPlayout'
import { useLibrary } from '@renderer/state/useLibrary'

/**
 * The arrangement: lanes of clips on one grid.
 *
 * `@waveform-playlist/engine` owns the timeline — which clips exist, where they
 * sit, what a cut or a drag does to them, and undo. This store owns the rest:
 * the master tempo, the audio each clip reads and the channel knobs. It mirrors
 * the library's state out for rendering.
 *
 * Holds no deck state. The arrangement is its own world.
 */

/** The range the master tempo can be set to. */
export const MASTER_BPM_MIN = 20
export const MASTER_BPM_MAX = 300

export function clampMasterBpm(bpm: number): number {
  return Math.min(MASTER_BPM_MAX, Math.max(MASTER_BPM_MIN, bpm))
}

/**
 * Lanes the arrangement opens with.
 *
 * Eight, so a track and the four stems split out of it fit together with room
 * left over. Colours run out after four and start again, which is why a lane
 * says its name rather than relying on its colour alone.
 */
const LANE_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const

function laneId(index: number): string {
  return `lane-${index + 1}`
}

/** The clip the next edit acts on. */
export interface ClipSelection {
  lane: string
  clipId: string
}

/** What is about to be dropped, and where it will land. */
export interface DropPreview {
  lane: string
  sourceId: string
  startSample: number
  durationSamples: number
  offsetSamples: number
  sourceDurationSamples: number
  rate: number
  /** True while the drag is making a copy and leaving the original in place. */
  copy: boolean
}

/** Which edge of a clip a trim is pulling. */
export type ClipEdge = 'left' | 'right'

/** A lane's channel knobs, which the timeline library does not model. */
export interface LaneChannel {
  eq: ChannelEq
  mode: EqMode
}

export interface ArrangementState {
  ready: boolean
  /** Frames per second of the engine's clock. Every clip position is in these. */
  sampleRate: number
  /** The grid everything is warped onto. */
  masterBpm: number
  /** Mirror of the library's tracks, for rendering. */
  lanes: ClipTrack[]
  /** Bumped by the library on every structural change. */
  version: number
  playing: boolean
  /** Length of the arrangement in seconds. */
  duration: number
  /** Sources being decoded right now, by library track id. */
  loading: string[]
  /** Peaks for every source laid into the arrangement, for drawing clips. */
  waveforms: Record<string, WaveformData>
  channels: Record<string, LaneChannel>
  /**
   * The name each lane took from the track laid on it, by lane id. A lane
   * with nothing on it ignores this and shows its number instead. See
   * `arrangement/laneTitle`.
   */
  titles: Record<string, string>
  /** The clip CUT and DELETE act on, or null when nothing is picked. */
  selection: ClipSelection | null
  /** The clip about to be dropped, and the lane it will land on. */
  preview: DropPreview | null
  /** Where a drag is holding the playhead, or null when nothing is dragging it. */
  scrub: number | null
  /** Why the last edit did nothing, for the bar to show. */
  notice: string | null
  /** How far the split of each track has got, 0-1, while one is running. */
  splitting: Record<string, number>
  /** Lanes drawn at a fraction of their height, by lane id. */
  collapsed: Record<string, boolean>

  init(): Promise<void>
  /** Lay a library track into a lane, warped onto the grid. */
  dropTrack(lane: string, trackId: string, atSeconds: number): Promise<void>
  /** Lay the browser's pick into the first lane with nothing on it. */
  dropSelectedIntoFreeLane(): Promise<void>
  moveClip(lane: string, clipId: string, deltaSeconds: number): void
  /**
   * Take hold of a clip. A move shows where it would land and puts it there on
   * release; a trim slides the clip's own edge as the pointer goes.
   *
   * Both work from the lanes as they were when the drag began, so pulling back
   * to where it started leaves everything as it was.
   */
  beginClipMove(lane: string, clipId: string): void
  /**
   * Where the held clip would land. Draws the shadow; moves nothing yet.
   *
   * `copy` leaves the original where it is and puts a second clip down, on the
   * same audio. The shadow says which it will be.
   */
  previewClipMove(toLane: string, startSample: number, copy?: boolean): void
  beginClipTrim(lane: string, clipId: string, edge: ClipEdge): void
  /** Pull the held edge to `atSample`. */
  previewClipTrim(atSample: number): void
  /** Put the held clip down. Whatever it covers gives way. */
  commitClipDrag(): void
  /** Let go and leave the lanes as they were. */
  cancelClipDrag(): void
  /** The clip being dragged, so it can be drawn as held. */
  heldClipId(): string | null
  /**
   * Put a second copy of the picked clip on the lane, straight after it, on
   * the same audio. Does nothing when nothing is picked.
   */
  duplicateSelected(): void
  /**
   * Split the picked clip's track into drums, bass, other and vocals, and lay
   * each on a lane of its own beside it. The clip itself is left alone.
   *
   * Takes four empty lanes. Sets {@link notice} when there are not four.
   */
  splitSelectedStems(): Promise<void>
  /** Draw a lane at a fraction of its height, or back at full height. */
  toggleCollapsed(lane: string): void
  /** Put one stem on an empty lane, lined up with the clip it came from. */
  layStem(lane: string, sourceId: string, title: string, like: ArrangementClip): void
  /** Group everything a drag does into one undo step. */
  beginDrag(): void
  endDrag(): void
  splitClip(lane: string, clipId: string, atSeconds: number): void
  removeClip(lane: string, clipId: string): void
  /** Peaks for a track that is not loaded, so a preview of it can be drawn. */
  ensurePeaks(trackId: string): Promise<void>
  select(selection: ClipSelection | null): void
  setPreview(preview: DropPreview | null): void
  /** Hold the playhead under a drag. Committed with {@link seek} on release. */
  setScrub(seconds: number | null): void
  /** Where the playhead is drawn: under a drag, that drag's position. */
  displaySeconds(): number
  /**
   * Length of a track's audio in frames: the decoded file when it is loaded,
   * the library's stored duration before that.
   */
  sourceFrames(trackId: string): number
  /** Delete the picked clip. Does nothing when nothing is picked. */
  removeSelected(): void
  /** Cut the picked clip at the playhead. Sets {@link notice} when refused. */
  cutSelected(): void
  clearNotice(): void
  setMasterBpm(bpm: number): void
  play(): void
  pause(): void
  toggle(): void
  seek(seconds: number): void
  positionSeconds(): number
  setLaneEq(lane: string, eq: ChannelEq): void
  setLaneVolume(lane: string, volume: number): void
  toggleMute(lane: string): void
  toggleSolo(lane: string): void
  undo(): void
  redo(): void
}

/** Decoded audio, one entry per library track however many clips read it. */
const sources = new Map<string, AudioBuffer>()

let engine: PlaylistEngine | null = null
let playout: WorkletPlayout | null = null
/** Whether a drag is open. A drag is one transaction and one undo step. */
let dragging = false

/** Seconds into the file where its first downbeat is. */
function downbeatSec(track: Track): number {
  return track.grid?.anchors?.[0]?.time ?? 0
}

/** The tempo a track was recorded at, or 0 when it has not been analysed. */
function trackBpm(track: Track): number {
  return track.grid?.anchors?.[0]?.bpm ?? track.bpm ?? 0
}

/**
 * Source frames consumed per arrangement frame, so a track's beats sit on the
 * grid. Below 1 is slower: a 150 track on a 120 grid reads at 0.8.
 */
function rateFor(track: Track, masterBpm: number): number {
  return playbackRate(trackBpm(track), masterBpm)
}

function laneById(lanes: ClipTrack[], id: string): ClipTrack | undefined {
  return lanes.find((lane) => lane.id === id)
}

/**
 * Give the halves of a split clip the source the original read.
 *
 * The library rebuilds clips from a fixed field list when it cuts one, so the
 * halves arrive without it. They are the only clips on the lane without one.
 */
function inheritSource(lane: ClipTrack, source: ArrangementClip): ClipTrack {
  return {
    ...lane,
    clips: lane.clips.map((clip) =>
      'sourceId' in clip
        ? clip
        : // The name comes back numbered; both halves are the same track.
          { ...clip, name: source.name, sourceId: source.sourceId, rate: source.rate }
    )
  }
}

/**
 * A clip drag in flight, with the lanes as they were when it began. Working
 * from that snapshot is what lets a drag be pulled back to where it started.
 */
let held: {
  kind: 'move' | ClipEdge
  fromLane: string
  clipId: string
  before: Record<string, ArrangementClip[]>
} | null = null

let clipSerial = 0

/** A name for a piece left behind when a clip is laid across another. */
function freshClipId(): string {
  clipSerial += 1
  return `clip-${Date.now().toString(36)}-${clipSerial}`
}

/** The clips of every lane, as the placement maths wants them. */
function laneClips(lanes: ClipTrack[], id: string): ArrangementClip[] {
  return (laneById(lanes, id)?.clips ?? []) as ArrangementClip[]
}

export const useArrangement = create<ArrangementState>()((set, get) => ({
  ready: false,
  sampleRate: 48000,
  masterBpm: 120,
  lanes: [],
  titles: {},
  version: 0,
  playing: false,
  duration: 0,
  loading: [],
  waveforms: {},
  channels: {},
  selection: null,
  splitting: {},
  collapsed: {},
  preview: null,
  scrub: null,
  notice: null,

  async init() {
    if (engine) return
    const audio = AudioEngine.shared()
    await audio.init()
    await ArrangementEngine.shared().init()

    playout = new WorkletPlayout({
      resolve: (sourceId) => sources.get(sourceId) ?? null,
      eqOf: (lane) => get().channels[lane] ?? null
    })
    engine = new PlaylistEngine({
      adapter: playout,
      sampleRate: ArrangementEngine.shared().sampleRate,
      bpm: get().masterBpm
    })
    await engine.init()

    const lanes: ClipTrack[] = LANE_NAMES.map((name, i) => ({
      id: laneId(i),
      name,
      clips: [],
      muted: false,
      soloed: false,
      volume: 1,
      pan: 0
    }))
    const channels: Record<string, LaneChannel> = {}
    for (const lane of lanes) channels[lane.id] = { eq: flatChannel(), mode: 'eq' }

    engine.setTracks(lanes)
    set({ sampleRate: ArrangementEngine.shared().sampleRate })
    engine.on('statechange', (state) => {
      set({
        lanes: state.tracks,
        version: state.tracksVersion,
        playing: state.isPlaying,
        duration: state.duration
      })
    })
    set({ ready: true, lanes, channels })
  },

  async dropTrack(lane, trackId, atSeconds) {
    if (!engine) await get().init()
    const playlist = engine
    if (!playlist) return
    const track = useLibrary.getState().trackById(trackId)
    if (!track?.path) return

    if (!sources.has(trackId)) {
      set({ loading: [...get().loading, trackId] })
      try {
        const decoded = await decodeTrack(AudioEngine.shared().ctx, track.path)
        sources.set(trackId, decoded)
        const peaks = await resolveWaveform(track, decoded)
        if (peaks) set({ waveforms: { ...get().waveforms, [trackId]: peaks } })
      } catch (err) {
        console.error('[arrangement] could not decode', track.path, err)
        return
      } finally {
        set({ loading: get().loading.filter((id) => id !== trackId) })
      }
    }
    const buffer = sources.get(trackId)
    if (!buffer) return

    // The first track into an empty arrangement sets the tempo. Every track
    // after it is warped onto that.
    const empty = playlist.getState().tracks.every((t) => t.clips.length === 0)
    if (empty && trackBpm(track) > 0) get().setMasterBpm(trackBpm(track))

    const sr = ArrangementEngine.shared().sampleRate
    const placed = placeClip({
      sourceFrames: buffer.length,
      downbeatSec: downbeatSec(track),
      trackBpm: trackBpm(track),
      masterBpm: get().masterBpm,
      atSeconds,
      sampleRate: sr
    })

    const clip: ArrangementClip = {
      ...createClip({
        startSample: placed.startSample,
        durationSamples: placed.durationSamples,
        offsetSamples: placed.offsetSamples,
        sampleRate: sr,
        sourceDurationSamples: placed.sourceDurationSamples,
        name: track.title
      }),
      sourceId: trackId,
      rate: placed.rate
    }

    const existing = laneById(playlist.getState().tracks, lane)
    if (!existing) return
    playlist.updateTrack(lane, { ...existing, clips: [...existing.clips, clip] })

    // A lane takes the name of the track that lands on it while it is empty.
    if (existing.clips.length === 0) {
      set({ titles: nameLane(get().titles, lane, track.title) })
    }
  },

  async dropSelectedIntoFreeLane() {
    const trackId = useLibrary.getState().selectedId
    if (!trackId) {
      set({ notice: 'Pick a track in the browser first' })
      return
    }
    const free = get().lanes.find((lane) => lane.clips.length === 0)
    if (!free) {
      set({ notice: 'Every lane already has something on it' })
      return
    }
    set({ notice: null })
    await get().dropTrack(free.id, trackId, 0)
  },

  moveClip(lane, clipId, deltaSeconds) {
    if (!engine) return
    engine.moveClip(lane, clipId, Math.round(deltaSeconds * get().sampleRate))
  },

  beginClipMove(lane, clipId) {
    if (!engine || held) return
    const clips = laneClips(engine.getState().tracks, lane)
    if (!clips.some((c) => c.id === clipId)) return
    const before: Record<string, ArrangementClip[]> = {}
    for (const l of engine.getState().tracks) before[l.id] = l.clips as ArrangementClip[]
    held = { kind: 'move', fromLane: lane, clipId, before }
    get().beginDrag()
  },

  previewClipMove(toLane, startSample, copy = false) {
    const grip = held
    if (!grip || grip.kind !== 'move') return
    const clip = grip.before[grip.fromLane]?.find((c) => c.id === grip.clipId)
    if (!clip) return
    const at = Math.max(0, Math.round(startSample))
    const shown = get().preview
    if (shown && shown.lane === toLane && shown.startSample === at && shown.copy === copy) return
    set({
      preview: {
        lane: toLane,
        sourceId: clip.sourceId,
        startSample: at,
        durationSamples: clip.durationSamples,
        offsetSamples: clip.offsetSamples,
        sourceDurationSamples: clip.sourceDurationSamples,
        rate: clip.rate,
        copy
      }
    })
  },

  beginClipTrim(lane, clipId, edge) {
    if (!engine || held) return
    const clips = laneClips(engine.getState().tracks, lane)
    if (!clips.some((c) => c.id === clipId)) return
    held = { kind: edge, fromLane: lane, clipId, before: { [lane]: clips } }
    get().beginDrag()
  },

  previewClipTrim(atSample) {
    const grip = held
    if (!engine || !grip || grip.kind === 'move') return
    const lane = laneById(engine.getState().tracks, grip.fromLane)
    if (!lane) return
    const clips = trimWithin(
      grip.before[grip.fromLane] as unknown as Placed[],
      grip.clipId,
      grip.kind,
      Math.max(0, Math.round(atSample)),
      freshClipId
    ) as unknown as ArrangementClip[]
    engine.updateTrack(lane.id, { ...lane, clips })
  },

  commitClipDrag() {
    if (!engine || !held) {
      get().endDrag()
      return
    }
    const grip = held
    held = null
    if (grip.kind === 'move') {
      const target = get().preview
      const clip = grip.before[grip.fromLane]?.find((c) => c.id === grip.clipId)
      set({ preview: null })
      if (target && clip) {
        // A copy is a second clip on the same audio, so it needs its own name.
        const moved = target.copy
          ? { ...clip, id: freshClipId(), startSample: target.startSample }
          : { ...clip, startSample: target.startSample }
        const laid = layOver(
          grip.before[target.lane] as unknown as Placed[],
          moved as unknown as Placed,
          freshClipId
        ) as unknown as ArrangementClip[]
        if (!target.copy && target.lane !== grip.fromLane) {
          const source = laneById(engine.getState().tracks, grip.fromLane)
          if (source) {
            engine.updateTrack(source.id, {
              ...source,
              clips: grip.before[grip.fromLane].filter((c) => c.id !== grip.clipId)
            })
          }
        }
        const into = laneById(engine.getState().tracks, target.lane)
        if (into) engine.updateTrack(into.id, { ...into, clips: laid })
        set({ selection: { lane: target.lane, clipId: moved.id } })
      }
    }
    get().endDrag()
  },

  cancelClipDrag() {
    if (!engine || !held) return
    const grip = held
    held = null
    set({ preview: null })
    for (const [id, clips] of Object.entries(grip.before)) {
      const lane = laneById(engine.getState().tracks, id)
      if (lane) engine.updateTrack(id, { ...lane, clips })
    }
    get().endDrag()
  },

  heldClipId() {
    return held ? held.clipId : null
  },

  toggleCollapsed(lane) {
    set({ collapsed: { ...get().collapsed, [lane]: !get().collapsed[lane] } })
  },

  async splitSelectedStems() {
    const picked = get().selection
    if (!picked) {
      set({ notice: 'Pick a clip to split first' })
      return
    }
    const lane = laneById(get().lanes, picked.lane)
    const clip = (lane?.clips as ArrangementClip[] | undefined)?.find(
      (c) => c.id === picked.clipId
    )
    if (!clip) return
    const track = useLibrary.getState().trackById(clip.sourceId)
    if (!track?.path) {
      set({ notice: 'That clip has no file behind it' })
      return
    }
    const free = get().lanes.filter((l) => l.clips.length === 0)
    if (free.length < STEM_NAMES.length) {
      set({ notice: `Splitting needs ${STEM_NAMES.length} empty tracks` })
      return
    }

    set({ notice: null, splitting: { ...get().splitting, [track.audioKey]: 0 } })
    try {
      const stop = window.api.onStemProgress((key, ratio) => {
        if (key === track.audioKey) set({ splitting: { ...get().splitting, [key]: ratio } })
      })
      let files: Record<StemName, string>
      try {
        files = await window.api.splitStems(track.audioKey, track.path)
      } finally {
        stop()
      }
      const ctx = AudioEngine.shared().ctx
      for (let i = 0; i < STEM_NAMES.length; i++) {
        const name = STEM_NAMES[i]
        const sourceId = stemSourceId(clip.sourceId, name)
        if (!sources.has(sourceId)) {
          const decoded = await decodeTrack(ctx, files[name])
          sources.set(sourceId, decoded)
          const peaks = await resolveWaveform(
            { ...track, id: sourceId, audioKey: `${track.audioKey}-${name}`, path: files[name] },
            decoded
          )
          if (peaks) set({ waveforms: { ...get().waveforms, [sourceId]: peaks } })
        }
        get().layStem(free[i].id, sourceId, `${track.title} ${name}`, clip)
      }
    } catch (err) {
      console.error('[arrangement] could not split', track.path, err)
      set({ notice: 'That track could not be split' })
    } finally {
      const rest = { ...get().splitting }
      delete rest[track.audioKey]
      set({ splitting: rest })
    }
  },

  layStem(laneId, sourceId, title, like) {
    if (!engine) return
    const lane = laneById(engine.getState().tracks, laneId)
    if (!lane) return
    const clip: ArrangementClip = {
      ...(createClip({
        startSample: like.startSample,
        durationSamples: like.durationSamples,
        offsetSamples: like.offsetSamples,
        sampleRate: get().sampleRate,
        sourceDurationSamples: like.sourceDurationSamples,
        name: title
      }) as ArrangementClip),
      sourceId,
      rate: like.rate
    }
    engine.updateTrack(laneId, { ...lane, clips: [clip] })
    set({ titles: { ...get().titles, [laneId]: title } })
  },

  duplicateSelected() {
    if (!engine) return
    const picked = get().selection
    if (!picked) return
    const lane = laneById(engine.getState().tracks, picked.lane)
    const clip = (lane?.clips as ArrangementClip[] | undefined)?.find((c) => c.id === picked.clipId)
    if (!lane || !clip) return
    const copy = {
      ...clip,
      id: freshClipId(),
      startSample: clip.startSample + clip.durationSamples
    }
    engine.beginTransaction()
    engine.updateTrack(lane.id, {
      ...lane,
      clips: layOver(
        lane.clips as unknown as Placed[],
        copy as unknown as Placed,
        freshClipId
      ) as unknown as ArrangementClip[]
    })
    engine.commitTransaction()
    set({ selection: { lane: lane.id, clipId: copy.id } })
  },

  beginDrag() {
    if (!engine || dragging) return
    dragging = true
    engine.beginTransaction()
  },

  endDrag() {
    if (!engine || !dragging) return
    dragging = false
    engine.commitTransaction()
  },

  splitClip(lane, clipId, atSeconds) {
    if (!engine) return
    const sr = ArrangementEngine.shared().sampleRate
    const before = laneById(engine.getState().tracks, lane)
    const cut = before?.clips.find((c) => c.id === clipId) as ArrangementClip | undefined
    if (!cut) return
    engine.splitClip(lane, clipId, Math.round(atSeconds * sr))
    const after = laneById(engine.getState().tracks, lane)
    if (after) engine.updateTrack(lane, inheritSource(after, cut))
  },

  removeClip(lane, clipId) {
    if (!engine) return
    const existing = laneById(engine.getState().tracks, lane)
    if (!existing) return
    engine.updateTrack(lane, {
      ...existing,
      clips: existing.clips.filter((clip) => clip.id !== clipId)
    })
    const picked = get().selection
    if (picked && picked.lane === lane && picked.clipId === clipId) set({ selection: null })
  },

  async ensurePeaks(trackId) {
    if (get().waveforms[trackId]) return
    const track = useLibrary.getState().trackById(trackId)
    if (!track) return
    const peaks = await peekWaveform(track.audioKey)
    if (peaks && !get().waveforms[trackId]) {
      set({ waveforms: { ...get().waveforms, [trackId]: peaks } })
    }
  },

  select(selection) {
    set({ selection })
  },

  setPreview(preview) {
    set({ preview })
  },

  setScrub(seconds) {
    set({ scrub: seconds === null ? null : Math.max(0, seconds) })
  },

  displaySeconds() {
    return get().scrub ?? ArrangementEngine.shared().positionSeconds()
  },

  sourceFrames(trackId) {
    const loaded = sources.get(trackId)
    if (loaded) return loaded.length
    const track = useLibrary.getState().trackById(trackId)
    return Math.max(0, Math.round((track?.durationSec ?? 0) * get().sampleRate))
  },

  removeSelected() {
    const picked = get().selection
    if (picked) get().removeClip(picked.lane, picked.clipId)
  },

  cutSelected() {
    const picked = get().selection
    if (!picked) {
      set({ notice: 'Click a clip first' })
      return
    }
    const lane = engine && laneById(engine.getState().tracks, picked.lane)
    const clip = lane?.clips.find((c) => c.id === picked.clipId)
    if (!clip) {
      set({ notice: 'That clip has gone' })
      return
    }
    const at = get().positionSeconds() * get().sampleRate
    if (at <= clip.startSample || at >= clip.startSample + clip.durationSamples) {
      set({ notice: 'The playhead is not over that clip' })
      return
    }
    get().splitClip(picked.lane, picked.clipId, get().positionSeconds())
    set({ selection: null, notice: null })
  },

  clearNotice() {
    set({ notice: null })
  },

  /**
   * Move the grid, and every clip with it.
   *
   * The library holds clip positions in beats and moves them itself. Lengths
   * are in frames, so they are rescaled to cover the same number of bars, and
   * each clip is re-warped to the new tempo.
   */
  setMasterBpm(bpm) {
    const next = clampMasterBpm(bpm)
    const previous = get().masterBpm
    if (!engine || !Number.isFinite(next) || next === previous) return
    const scale = previous / next
    engine.setTempo(next)
    set({ masterBpm: next })

    const library = useLibrary.getState()
    for (const lane of engine.getState().tracks) {
      if (lane.clips.length === 0) continue
      const clips = lane.clips.map((clip) => {
        const source = clip as ArrangementClip
        const track = library.trackById(source.sourceId)
        return {
          ...clip,
          durationSamples: Math.max(1, Math.round(clip.durationSamples * scale)),
          offsetSamples: Math.round(clip.offsetSamples * scale),
          sourceDurationSamples: Math.round(clip.sourceDurationSamples * scale),
          rate: track ? rateFor(track, next) : source.rate
        }
      })
      engine.updateTrack(lane.id, { ...lane, clips })
    }
  },

  play() {
    engine?.play(ArrangementEngine.shared().positionSeconds())
    set({ playing: true })
  },

  pause() {
    engine?.pause()
    set({ playing: false })
  },

  toggle() {
    if (ArrangementEngine.shared().playing) get().pause()
    else get().play()
  },

  seek(seconds) {
    engine?.seek(Math.max(0, seconds))
  },

  positionSeconds() {
    return ArrangementEngine.shared().positionSeconds()
  },

  setLaneEq(lane, eq) {
    const channel = get().channels[lane] ?? { eq: flatChannel(), mode: 'eq' as EqMode }
    const next = { ...channel, eq }
    set({ channels: { ...get().channels, [lane]: next } })
    playout?.applyEq(lane, next)
  },

  setLaneVolume(lane, volume) {
    engine?.setTrackVolume(lane, volume)
  },

  toggleMute(lane) {
    const current = laneById(get().lanes, lane)
    if (current) engine?.setTrackMute(lane, !current.muted)
  },

  toggleSolo(lane) {
    const current = laneById(get().lanes, lane)
    if (current) engine?.setTrackSolo(lane, !current.soloed)
  },

  undo() {
    engine?.undo()
  },

  redo() {
    engine?.redo()
  }
}))
