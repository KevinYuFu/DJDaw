import type { ChannelEq, EqMode } from '@shared/eq'
import { clamp } from '@renderer/core/format'
import { applyChannelStrip, createChannelStrip, type ChannelStrip } from '@renderer/audio/Deck'
import { Voice } from '@renderer/audio/Voice'
import type { VoiceClip } from '@renderer/audio/voiceProtocol'

/** +12 dB ceiling. A stray value from the UI must never reach the graph. */
const MAX_GAIN = 4

/** What one source contributes to a lane: its audio, its speed, its pieces. */
export interface LaneSource {
  sourceId: string
  buffer: AudioBuffer
  /** Source frames consumed per arrangement frame. */
  rate: number
  clips: VoiceClip[]
}

/**
 * One track of the arrangement.
 *
 * Owns a voice per source laid into it and sums them through one channel
 * strip, so the EQ, fader and mute/solo apply to the whole lane.
 *
 *   voice ─┐
 *   voice ─┼─> trim ─> EQ ─> filter ─> fader ─> pan ─> (master)
 *   voice ─┘
 */
export class Lane {
  readonly id: string

  private readonly ctx: AudioContext
  private readonly strip: ChannelStrip
  private readonly fader: GainNode
  private readonly panner: StereoPannerNode
  private readonly voices = new Map<string, Voice>()
  /** Fader position, separate from the mute/solo gate. */
  private volume = 1
  private audible = true

  constructor(id: string, ctx: AudioContext, destination: AudioNode) {
    this.id = id
    this.ctx = ctx
    this.strip = createChannelStrip(ctx)
    this.fader = ctx.createGain()
    this.panner = ctx.createStereoPanner()
    this.strip.filter.connect(this.fader)
    this.fader.connect(this.panner)
    this.panner.connect(destination)
  }

  /**
   * Put the lane's sources in place, adding, updating and dropping voices.
   *
   * A source already here keeps its voice and its loaded audio. Returns the
   * voices that had to be built, which are the ones a running transport starts.
   */
  setSources(sources: readonly LaneSource[]): Voice[] {
    const wanted = new Set(sources.map((s) => s.sourceId))
    for (const [id, voice] of this.voices) {
      if (wanted.has(id)) continue
      voice.dispose()
      this.voices.delete(id)
    }
    const fresh: Voice[] = []
    for (const source of sources) {
      let voice = this.voices.get(source.sourceId)
      if (!voice) {
        voice = new Voice(source.sourceId, this.ctx, this.strip.input)
        voice.load(source.buffer)
        this.voices.set(source.sourceId, voice)
        fresh.push(voice)
      }
      voice.setRate(source.rate)
      voice.setClips(source.clips)
    }
    return fresh
  }

  start(fromFrame: number, atContextFrame: number): void {
    for (const voice of this.voices.values()) voice.start(fromFrame, atContextFrame)
  }

  stop(): void {
    for (const voice of this.voices.values()) voice.stop()
  }

  seek(frame: number): void {
    for (const voice of this.voices.values()) voice.seek(frame)
  }

  /** Fader position, 1 at unity. */
  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return
    this.volume = clamp(volume, 0, MAX_GAIN)
    this.applyGain()
  }

  /**
   * Whether the lane is heard at all.
   *
   * One gate for mute and solo together. The store resolves which wins.
   */
  setAudible(audible: boolean): void {
    this.audible = audible
    this.applyGain()
  }

  /** -1 hard left, 0 centre, 1 hard right. */
  setPan(pan: number): void {
    if (!Number.isFinite(pan)) return
    this.panner.pan.setTargetAtTime(clamp(pan, -1, 1), this.ctx.currentTime, 0.008)
  }

  setEq(eq: ChannelEq, mode: EqMode): void {
    applyChannelStrip(this.strip, eq, mode, this.ctx.currentTime)
  }

  dispose(): void {
    for (const voice of this.voices.values()) voice.dispose()
    this.voices.clear()
    this.fader.disconnect()
    this.panner.disconnect()
  }

  private applyGain(): void {
    const target = this.audible ? this.volume : 0
    this.fader.gain.setTargetAtTime(target, this.ctx.currentTime, 0.008)
  }
}
