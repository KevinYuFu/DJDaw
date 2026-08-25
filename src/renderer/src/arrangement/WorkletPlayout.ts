import { PPQN, type AudioClip, type ClipTrack } from '@waveform-playlist/core'
import type { PlayoutAdapter } from '@waveform-playlist/engine'
import { ArrangementEngine } from '@renderer/audio/ArrangementEngine'
import type { LaneSource } from '@renderer/audio/Lane'
import type { ChannelEq, EqMode } from '@shared/eq'

/**
 * What a clip needs that the timeline library does not model: where its audio
 * comes from, and how fast that audio runs to sit on the grid.
 *
 * Every length the library holds is in arrangement frames, `offsetSamples`
 * included — how far into the source the clip starts, measured on the grid.
 * This rate is what converts those back to source frames.
 */
export interface ClipSource {
  /** Library track the audio comes from. */
  sourceId: string
  /** Source frames consumed per arrangement frame. */
  rate: number
}

export type ArrangementClip = AudioClip & ClipSource

function sourceOf(clip: AudioClip): ClipSource | null {
  const candidate = clip as Partial<ArrangementClip>
  if (typeof candidate.sourceId !== 'string') return null
  const rate = typeof candidate.rate === 'number' && candidate.rate > 0 ? candidate.rate : 1
  return { sourceId: candidate.sourceId, rate }
}

/** Where a lane's channel knobs come from, since the library models neither. */
export interface LaneEq {
  eq: ChannelEq
  mode: EqMode
}

export interface WorkletPlayoutOptions {
  /** The decoded audio for a source, or null while it is still loading. */
  resolve(sourceId: string): AudioBuffer | null
  /** The EQ a lane is set to, or null for flat. */
  eqOf?(laneId: string): LaneEq | null
}

/**
 * The seam between the timeline library and DJDaw's audio.
 *
 * Turns each track of clips into lanes and voices, and runs the transport.
 * Nothing above this line knows about worklets; nothing below it knows about
 * the timeline model.
 */
export class WorkletPlayout implements PlayoutAdapter {
  readonly ppqn = PPQN

  private readonly engine = ArrangementEngine.shared()
  private readonly options: WorkletPlayoutOptions
  private readonly known = new Set<string>()
  private soloed = new Set<string>()
  private muted = new Set<string>()
  private bpm = 120

  constructor(options: WorkletPlayoutOptions) {
    this.options = options
  }

  get audioContext(): AudioContext {
    return this.engine.ctx
  }

  init(): Promise<void> {
    return this.engine.init()
  }

  setTracks(tracks: ClipTrack[]): void {
    const wanted = new Set(tracks.map((t) => t.id))
    for (const id of this.known) {
      if (!wanted.has(id)) {
        this.engine.removeLane(id)
        this.known.delete(id)
      }
    }
    for (const track of tracks) this.updateTrack(track.id, track)
  }

  addTrack(track: ClipTrack): void {
    this.updateTrack(track.id, track)
  }

  removeTrack(trackId: string): void {
    this.engine.removeLane(trackId)
    this.known.delete(trackId)
    this.soloed.delete(trackId)
    this.muted.delete(trackId)
  }

  /**
   * Rebuild one lane from its clips.
   *
   * Grouped by source: a voice plays one file at one speed, so two songs on a
   * lane are two voices summed.
   */
  updateTrack(trackId: string, track: ClipTrack): void {
    this.known.add(trackId)
    const bySource = new Map<string, LaneSource>()
    for (const clip of track.clips) {
      const source = sourceOf(clip)
      if (!source) continue
      const buffer = this.options.resolve(source.sourceId)
      if (!buffer) continue
      let entry = bySource.get(source.sourceId)
      if (!entry) {
        entry = { sourceId: source.sourceId, buffer, rate: source.rate, clips: [] }
        bySource.set(source.sourceId, entry)
      }
      entry.clips.push({
        start: clip.startSample,
        end: clip.startSample + clip.durationSamples,
        src: clip.offsetSamples * source.rate
      })
    }
    for (const entry of bySource.values()) entry.clips.sort((a, b) => a.start - b.start)
    this.engine.setLaneSources(trackId, [...bySource.values()])

    const lane = this.engine.lane(trackId)
    lane.setVolume(track.volume)
    lane.setPan(track.pan)
    if (track.muted) this.muted.add(trackId)
    else this.muted.delete(trackId)
    if (track.soloed) this.soloed.add(trackId)
    else this.soloed.delete(trackId)
    const knobs = this.options.eqOf?.(trackId)
    if (knobs) lane.setEq(knobs.eq, knobs.mode)
    this.applyAudibility()
  }

  play(startTime: number): void {
    this.engine.play(startTime)
  }

  pause(): void {
    this.engine.pause()
  }

  stop(): void {
    this.engine.pause()
    this.engine.seek(0)
  }

  seek(time: number): void {
    this.engine.seek(time)
  }

  getCurrentTime(): number {
    return this.engine.positionSeconds()
  }

  isPlaying(): boolean {
    return this.engine.playing
  }

  /** No-op: the master fader is an app-level control. */
  setMasterVolume(): void {}

  setTrackVolume(trackId: string, volume: number): void {
    this.engine.lane(trackId).setVolume(volume)
  }

  setTrackMute(trackId: string, mutedFlag: boolean): void {
    if (mutedFlag) this.muted.add(trackId)
    else this.muted.delete(trackId)
    this.applyAudibility()
  }

  setTrackSolo(trackId: string, soloedFlag: boolean): void {
    if (soloedFlag) this.soloed.add(trackId)
    else this.soloed.delete(trackId)
    this.applyAudibility()
  }

  setTrackPan(trackId: string, pan: number): void {
    this.engine.lane(trackId).setPan(pan)
  }

  /** No-op: arrangement looping is not implemented. */
  setLoop(): void {}

  setTempo(bpm: number): boolean {
    if (!(bpm > 0)) return false
    this.bpm = bpm
    return true
  }

  ticksToSeconds(tick: number): number {
    return (tick / this.ppqn) * (60 / this.bpm)
  }

  secondsToTicks(seconds: number): number {
    return (seconds / (60 / this.bpm)) * this.ppqn
  }

  /** Push the EQ a lane is set to into the graph. */
  applyEq(trackId: string, knobs: LaneEq): void {
    this.engine.lane(trackId).setEq(knobs.eq, knobs.mode)
  }

  dispose(): void {
    this.engine.dispose()
    this.known.clear()
  }

  /** With anything soloed, everything else is silent. */
  private applyAudibility(): void {
    const anySolo = this.soloed.size > 0
    for (const id of this.known) {
      const audible = anySolo ? this.soloed.has(id) : !this.muted.has(id)
      this.engine.lane(id).setAudible(audible)
    }
  }
}
