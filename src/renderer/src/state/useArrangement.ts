import { create } from 'zustand'
import { createClip, type ClipTrack } from '@waveform-playlist/core'
import { PlaylistEngine } from '@waveform-playlist/engine'
import { type ChannelEq, type EqMode, flatChannel } from '@shared/eq'
import type { Track, WaveformData } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { ArrangementEngine } from '@renderer/audio/ArrangementEngine'
import { decodeTrack } from '@renderer/audio/decode'
import { playbackRate } from '@renderer/analysis/playbackRate'
import { resolveWaveform } from '@renderer/analysis/waveformCache'
import { WorkletPlayout, type ArrangementClip } from '@renderer/arrangement/WorkletPlayout'
import { useLibrary } from '@renderer/state/useLibrary'

/**
 * The arrangement: lanes of clips on one grid, the way Ableton lays a set out.
 *
 * The timeline itself is not modelled here. `@waveform-playlist/engine` owns
 * which clips exist, where they sit and what a cut or a drag does to them,
 * including undo; this store owns everything that library has no opinion on —
 * the master tempo, the audio each clip reads, the channel knobs — and mirrors
 * the library's state out so React can render it.
 *
 * Nothing here touches a deck. The arrangement is its own world.
 */

/** The range the master tempo can be set to. */
export const MASTER_BPM_MIN = 20
export const MASTER_BPM_MAX = 300

export function clampMasterBpm(bpm: number): number {
  return Math.min(MASTER_BPM_MAX, Math.max(MASTER_BPM_MIN, bpm))
}

/** Lanes the arrangement opens with. More is a longer list, nothing else. */
const LANE_NAMES = ['A', 'B', 'C', 'D'] as const

function laneId(index: number): string {
  return `lane-${index + 1}`
}

/** A lane's channel knobs, which the timeline library does not model. */
export interface LaneChannel {
  eq: ChannelEq
  mode: EqMode
}

export interface ArrangementState {
  ready: boolean
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

  init(): Promise<void>
  /** Lay a library track into a lane, warped onto the grid. */
  dropTrack(lane: string, trackId: string, atSeconds: number): Promise<void>
  moveClip(lane: string, clipId: string, deltaSeconds: number): void
  splitClip(lane: string, clipId: string, atSeconds: number): void
  removeClip(lane: string, clipId: string): void
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
 * Re-attach what a split drops.
 *
 * The library rebuilds clips from a fixed field list when it cuts one, so the
 * two halves come back without the source they read. They are the only clips on
 * the lane that lost it, and they are halves of the one clip that was cut.
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

export const useArrangement = create<ArrangementState>()((set, get) => ({
  ready: false,
  masterBpm: 120,
  lanes: [],
  version: 0,
  playing: false,
  duration: 0,
  loading: [],
  waveforms: {},
  channels: {},

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

    // The first track into an empty arrangement names the tempo instead of
    // being warped to it, the way dropping the first clip into an empty set
    // does. Everything after it is warped onto that.
    const empty = playlist.getState().tracks.every((t) => t.clips.length === 0)
    if (empty && trackBpm(track) > 0) get().setMasterBpm(trackBpm(track))

    const sr = ArrangementEngine.shared().sampleRate
    const masterBpm = get().masterBpm
    const rate = rateFor(track, masterBpm)

    // The clip is placed so the track's first downbeat lands on the drop point,
    // which is what puts it in phase with everything else on the grid. The
    // intro before that downbeat keeps its place ahead of the clip, the way it
    // does in a DAW, and is trimmed off only where it would run before zero.
    const introFrames = (downbeatSec(track) * sr) / rate
    const wholeFrames = buffer.length / rate
    const dropFrame = Math.max(0, Math.round(atSeconds * sr))
    const startSample = Math.max(0, Math.round(dropFrame - introFrames))
    const offsetSamples = Math.round(Math.max(0, introFrames - dropFrame))

    const clip: ArrangementClip = {
      ...createClip({
        startSample,
        durationSamples: Math.max(1, Math.round(wholeFrames - offsetSamples)),
        offsetSamples,
        sampleRate: sr,
        sourceDurationSamples: Math.round(wholeFrames),
        name: track.title
      }),
      sourceId: trackId,
      rate
    }

    const existing = laneById(playlist.getState().tracks, lane)
    if (!existing) return
    playlist.updateTrack(lane, { ...existing, clips: [...existing.clips, clip] })
  },

  moveClip(lane, clipId, deltaSeconds) {
    if (!engine) return
    const sr = ArrangementEngine.shared().sampleRate
    engine.moveClip(lane, clipId, Math.round(deltaSeconds * sr))
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
  },

  /**
   * Move the grid, and every clip with it.
   *
   * Clip positions are held in beats by the library, so they follow on their
   * own. Their lengths are in frames, so a clip that was eight bars long has to
   * be rescaled to stay eight bars long, and re-warped to the new tempo.
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
