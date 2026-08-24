import { AudioEngine } from '@renderer/audio/AudioEngine'
import { Lane, type LaneSource } from '@renderer/audio/Lane'
import { VOICE_WORKLET_URL } from '@renderer/audio/voiceProtocol'

/**
 * The arrangement's audio: a set of lanes and one clock.
 *
 * Nothing here is shared with the decks. They sit on the same output device —
 * there is only one — but a lane is not a deck, holds its own audio and takes
 * no instruction from the performance side.
 *
 * The clock is the point of the whole thing. Every voice advances at exactly
 * one frame per frame and they are all started on a named context frame, so
 * once they are running they are locked together to the sample for as long as
 * they play. Nothing re-syncs, because nothing drifts.
 */

/** How far ahead a start is scheduled, so every voice gets the message in time. */
const START_LEAD_SEC = 0.08

export class ArrangementEngine {
  private static instance: ArrangementEngine | null = null

  private lanes = new Map<string, Lane>()
  private ready: Promise<void> | null = null

  /** Arrangement position the current run started from, in seconds. */
  private startedFrom = 0
  /** Context time that run begins at, or null when stopped. */
  private startedAt: number | null = null
  /** Where the playhead rests while stopped. */
  private restAt = 0

  static shared(): ArrangementEngine {
    if (!ArrangementEngine.instance) ArrangementEngine.instance = new ArrangementEngine()
    return ArrangementEngine.instance
  }

  get ctx(): AudioContext {
    return AudioEngine.shared().ctx
  }

  get sampleRate(): number {
    return this.ctx.sampleRate
  }

  /** Load the voice worklet. The engine's own context is built by `AudioEngine`. */
  init(): Promise<void> {
    if (!this.ready) {
      this.ready = this.ctx.audioWorklet
        .addModule(new URL(VOICE_WORKLET_URL, window.location.href).href)
        .catch((err: unknown) => {
          this.ready = null
          throw err
        })
    }
    return this.ready
  }

  lane(id: string): Lane {
    let lane = this.lanes.get(id)
    if (!lane) {
      lane = new Lane(id, this.ctx, AudioEngine.shared().master)
      this.lanes.set(id, lane)
    }
    return lane
  }

  removeLane(id: string): void {
    this.lanes.get(id)?.dispose()
    this.lanes.delete(id)
  }

  /** Hand a lane its sources. Voices are added, updated and dropped to match. */
  setLaneSources(id: string, sources: readonly LaneSource[]): void {
    const fresh = this.lane(id).setSources(sources)
    // A voice built while the transport is running joins the run in progress.
    // Only the new ones: restarting the others would jump them.
    if (this.startedAt === null || fresh.length === 0) return
    const at = this.atNextStart()
    const from = this.positionSeconds() + START_LEAD_SEC
    const frame = Math.round(from * this.sampleRate)
    for (const voice of fresh) voice.start(frame, at)
  }

  get playing(): boolean {
    return this.startedAt !== null
  }

  /** Where the playhead is now, in seconds. */
  positionSeconds(): number {
    if (this.startedAt === null) return this.restAt
    return this.startedFrom + Math.max(0, this.ctx.currentTime - this.startedAt)
  }

  play(fromSeconds?: number): void {
    const from = fromSeconds ?? this.restAt
    const at = this.atNextStart()
    this.startedFrom = from
    this.startedAt = this.ctx.currentTime + START_LEAD_SEC
    const frame = Math.round(from * this.sampleRate)
    for (const lane of this.lanes.values()) lane.start(frame, at)
  }

  pause(): void {
    if (this.startedAt === null) return
    this.restAt = this.positionSeconds()
    this.startedAt = null
    for (const lane of this.lanes.values()) lane.stop()
  }

  seek(seconds: number): void {
    const at = Math.max(0, seconds)
    if (this.startedAt === null) {
      this.restAt = at
      const frame = Math.round(at * this.sampleRate)
      for (const lane of this.lanes.values()) lane.seek(frame)
      return
    }
    // Seeking while running is a restart from the new position: the voices
    // have to be re-aimed together or they would land a message apart.
    this.play(at)
  }

  dispose(): void {
    for (const lane of this.lanes.values()) lane.dispose()
    this.lanes.clear()
    this.startedAt = null
  }

  /** The context frame a start should land on, a little way ahead of now. */
  private atNextStart(): number {
    return Math.round((this.ctx.currentTime + START_LEAD_SEC) * this.sampleRate)
  }
}
