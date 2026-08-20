import type { DeckId } from '@shared/types'
import type { Region } from '@shared/clips'
import { clamp } from '@renderer/core/format'
import {
  DECK_PROCESSOR_NAME,
  type DeckCommand,
  type DeckEvent,
  type RegionFrames
} from '@renderer/audio/deckProtocol'

/**
 * One deck: the typed façade over `worklets/deck-processor.js`.
 *
 * Everything the transport does is a message to the worklet, which owns the
 * only authoritative playhead. The main thread keeps the worklet's last report
 * and extrapolates from it with `ctx.currentTime`, so the waveform can be drawn
 * at full frame rate without asking the audio thread for a position 60 times a
 * second.
 */

/** The worklet's last report, plus the context clock it was sampled on. */
export interface DeckSnapshot {
  /** Playhead in fractional frames. */
  frame: number
  playing: boolean
  scrubbing: boolean
  /** Effective playback rate after the worklet's smoothing. 0 when stopped. */
  rate: number
  /** `AudioContext.currentTime` at which `frame` was true. */
  ctxTime: number
}

/**
 * 128-frame quanta between state reports: ~8 ms at 48 kHz. Often enough that
 * extrapolation error stays well under a millisecond, rare enough that the
 * message port is not the bottleneck.
 */
const STATE_REPORT_QUANTA = 3

/**
 * How long play()/pause() trusts its own answer over the worklet's. A report
 * sampled just before the command was handled still says the old thing, and
 * adopting it would flicker the play button for one UI frame.
 */
const TRANSPORT_ACK_MS = 250

/** +12 dB ceiling. A stray value from the UI must never reach the graph. */
const MAX_GAIN = 4

/** Rate ceiling. The tempo fader tops out at 2x; this is pure sanity. */
const MAX_RATE = 4

export class Deck {
  readonly id: DeckId
  readonly node: AudioWorkletNode
  readonly output: GainNode

  /** Length of the loaded audio in frames. 0 when the deck is empty. */
  frames = 0
  /**
   * Sample rate of the loaded audio. Buffers come from `decodeAudioData`, so
   * this is the context rate in practice, and one frame of playhead motion is
   * one frame of context time at rate 1.
   */
  fileSampleRate: number
  /**
   * Length of the deck's timeline in seconds. On an uncut deck that is the
   * length of the file; once regions are set it is the end of the last one,
   * which is what every seek, loop and waveform clamps against.
   */
  durationSec = 0

  private readonly ctx: AudioContext
  /** Length of the file itself, to fall back on when the regions are cleared. */
  private sourceDurationSec = 0
  /** The deck's timeline, empty when it plays the whole file straight through. */
  private regions: RegionFrames[] = []
  private lastSnapshot: DeckSnapshot
  /** Transport state as last reported by the worklet. */
  private reportedPlaying = false
  /** Optimistic transport state, until the worklet confirms or the ack expires. */
  private pendingPlaying: boolean | null = null
  private pendingUntil = 0
  private readonly stateListeners = new Set<(s: DeckSnapshot) => void>()
  private readonly endedListeners = new Set<() => void>()

  constructor(id: DeckId, ctx: AudioContext, destination: AudioNode) {
    this.id = id
    this.ctx = ctx
    this.fileSampleRate = ctx.sampleRate

    this.node = new AudioWorkletNode(ctx, DECK_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    })
    this.output = ctx.createGain()
    this.node.connect(this.output)
    this.output.connect(destination)

    this.node.port.onmessage = (e: MessageEvent<DeckEvent>) => this.handleEvent(e.data)
    this.lastSnapshot = { frame: 0, playing: false, scrubbing: false, rate: 0, ctxTime: ctx.currentTime }

    // Pin the report rate rather than inheriting the worklet's default, so
    // extrapolation accuracy is a property of this file.
    this.post({ type: 'reportInterval', quanta: STATE_REPORT_QUANTA })
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Hand the deck its audio. The channel data is copied and the copies are
   * transferred, because transferring the views `getChannelData()` returns
   * would detach the AudioBuffer that analysis and export still need.
   */
  load(buffer: AudioBuffer): void {
    this.frames = buffer.length
    this.fileSampleRate = buffer.sampleRate
    this.sourceDurationSec = buffer.duration
    this.durationSec = buffer.duration
    // A timeline belongs to the track it was cut from. The worklet drops its
    // regions on load too, so both sides start the new track uncut.
    this.regions = []

    // Mono files ship one channel and the worklet duplicates it to both
    // outputs. Above stereo only the front pair is kept: a two-channel deck
    // has nowhere to put the rest.
    const channelCount = Math.min(buffer.numberOfChannels, 2)
    const channels: Float32Array[] = []
    const transfer: ArrayBuffer[] = []
    for (let c = 0; c < channelCount; c++) {
      const copy = buffer.getChannelData(c).slice()
      channels.push(copy)
      transfer.push(copy.buffer)
    }

    this.resetState()
    this.post(
      {
        type: 'load',
        stems: [{ id: 'master', channels }],
        frames: buffer.length,
        sampleRate: buffer.sampleRate
      },
      transfer
    )
    this.emitState()
  }

  /** Drop the audio and report an empty deck to every listener. */
  unload(): void {
    this.post({ type: 'unload' })
    this.frames = 0
    this.durationSec = 0
    this.sourceDurationSec = 0
    this.regions = []
    this.fileSampleRate = this.ctx.sampleRate
    this.resetState()
    this.emitState()
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  play(): void {
    // The worklet ignores play on an empty deck; claiming otherwise would
    // leave the UI showing a deck that never starts.
    if (this.frames === 0) return
    this.post({ type: 'play' })
    // Playing from the end restarts the file in the worklet; mirror that here
    // so the playhead does not sit at the end until the next report.
    if (this.positionFrame() >= this.timelineFrames() - 1) {
      this.lastSnapshot = { ...this.lastSnapshot, frame: 0, ctxTime: this.ctx.currentTime }
    }
    this.expectPlaying(true)
    this.emitState()
  }

  pause(): void {
    this.post({ type: 'pause' })
    // Freeze the extrapolation where the playhead is right now, otherwise it
    // coasts on the old rate until the next report lands.
    this.lastSnapshot = {
      ...this.lastSnapshot,
      frame: this.positionFrame(),
      rate: 0,
      ctxTime: this.ctx.currentTime
    }
    this.expectPlaying(false)
    this.emitState()
  }

  togglePlay(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  /**
   * Optimistic while a play/pause command is in flight — a button that waits
   * ~9 ms for the audio thread feels broken — then whatever the worklet says,
   * which is how running off the end of the track gets reflected.
   */
  get playing(): boolean {
    return this.pendingPlaying ?? this.reportedPlaying
  }

  get scrubbing(): boolean {
    return this.lastSnapshot.scrubbing
  }

  seekSeconds(sec: number): void {
    const t = clamp(sec, 0, this.durationSec)
    const frame = Math.round(t * this.fileSampleRate)
    this.post({ type: 'seek', frame })
    // Move the local playhead at once: a click on the waveform must land
    // before the worklet's next report, or dragging feels rubber-banded.
    this.lastSnapshot = { ...this.lastSnapshot, frame, ctxTime: this.ctx.currentTime }
    this.emitState()
  }

  /**
   * Playhead in frames, extrapolated from the last worklet report. Cheap
   * enough to call several times per animation frame.
   */
  positionFrame(): number {
    const snap = this.lastSnapshot
    let frame = snap.frame
    if (snap.rate !== 0) {
      frame += (this.ctx.currentTime - snap.ctxTime) * snap.rate * this.fileSampleRate
    }
    return clamp(frame, 0, this.timelineFrames())
  }

  /** {@link positionFrame} in seconds, clamped to the loaded track. */
  positionSeconds(): number {
    if (this.fileSampleRate <= 0) return 0
    return clamp(this.positionFrame() / this.fileSampleRate, 0, this.durationSec)
  }

  // -------------------------------------------------------------------------
  // Parameters
  // -------------------------------------------------------------------------

  /** 1 = original tempo. The worklet ramps to it, so tempo moves never zipper. */
  setRate(rate: number): void {
    if (!Number.isFinite(rate)) return
    this.post({ type: 'rate', rate: clamp(rate, 0, MAX_RATE) })
  }

  setGain(linear: number): void {
    if (!Number.isFinite(linear)) return
    this.post({ type: 'gain', gain: clamp(linear, 0, MAX_GAIN) })
  }

  /**
   * Set the pieces this deck plays, in timeline order.
   *
   * An empty list puts the deck back to playing the whole file, which is what
   * an uncut deck wants and what the two performance decks always send.
   */
  setRegions(regions: Region[]): void {
    const sr = this.fileSampleRate
    this.regions = regions
      .map((r) => ({
        startFrame: Math.round(r.startSec * sr),
        endFrame: Math.round((r.startSec + r.durationSec) * sr),
        sourceOffsetFrame: Math.round(r.sourceOffsetSec * sr)
      }))
      .filter((r) => r.endFrame > r.startFrame)
    // Timeline seconds, not file seconds: cutting a track changes how long the
    // row is, and everything that clamps a position clamps against this.
    this.durationSec = this.regions.length > 0
      ? this.timelineFrames() / sr
      : this.sourceDurationSec
    this.post({ type: 'regions', regions: this.regions })
  }

  /** Timeline length in frames: the end of the last region, else the file. */
  private timelineFrames(): number {
    const last = this.regions[this.regions.length - 1]
    return last ? last.endFrame : this.frames
  }

  setLoop(enabled: boolean, startSec: number, endSec: number): void {
    const start = clamp(startSec, 0, this.durationSec)
    const end = clamp(endSec, 0, this.durationSec)
    this.post({
      type: 'loop',
      enabled: enabled && end > start,
      startFrame: Math.round(start * this.fileSampleRate),
      endFrame: Math.round(end * this.fileSampleRate)
    })
  }

  // -------------------------------------------------------------------------
  // Scrubbing (jog wheel / waveform drag)
  // -------------------------------------------------------------------------

  beginScrub(): void {
    this.post({ type: 'scrub', active: true })
  }

  scrubToSeconds(sec: number): void {
    const t = clamp(sec, 0, this.durationSec)
    this.post({ type: 'scrubTarget', frame: Math.round(t * this.fileSampleRate) })
  }

  endScrub(): void {
    this.post({ type: 'scrub', active: false })
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  /** @returns an unsubscribe function. */
  onState(cb: (s: DeckSnapshot) => void): () => void {
    this.stateListeners.add(cb)
    return () => {
      this.stateListeners.delete(cb)
    }
  }

  /** Fired when playback runs off the end of the track. @returns an unsubscribe function. */
  onEnded(cb: () => void): () => void {
    this.endedListeners.add(cb)
    return () => {
      this.endedListeners.delete(cb)
    }
  }

  /** The last known state, with the optimistic transport flag applied. */
  snapshot(): DeckSnapshot {
    return { ...this.lastSnapshot, playing: this.playing }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private handleEvent(event: DeckEvent): void {
    switch (event.type) {
      case 'loaded':
        // Ignored after an unload that overtook the load in flight: the deck
        // is empty now, whatever the worklet was still confirming.
        if (this.frames !== 0) this.frames = event.frames
        break

      case 'state': {
        this.lastSnapshot = {
          frame: event.frame,
          playing: event.playing,
          scrubbing: event.scrubbing,
          rate: event.rate,
          ctxTime: event.ctxTime
        }
        this.reportedPlaying = event.playing
        if (this.pendingPlaying !== null) {
          // Either the worklet has caught up with the command, or it never
          // will (it refuses play on an empty deck) and the ack window is up.
          if (event.playing === this.pendingPlaying || performance.now() >= this.pendingUntil) {
            this.pendingPlaying = null
          }
        }
        this.emitState()
        break
      }

      case 'ended': {
        this.lastSnapshot = {
          frame: event.frame,
          playing: false,
          scrubbing: this.lastSnapshot.scrubbing,
          rate: 0,
          ctxTime: this.ctx.currentTime
        }
        this.reportedPlaying = false
        // Reaching the end beats any optimistic play() still in flight.
        this.pendingPlaying = null
        this.emitState()
        for (const cb of this.endedListeners) cb()
        break
      }
    }
  }

  private expectPlaying(playing: boolean): void {
    this.pendingPlaying = playing
    this.pendingUntil = performance.now() + TRANSPORT_ACK_MS
  }

  /** Back to a stopped playhead at frame 0, matching what load/unload do. */
  private resetState(): void {
    this.lastSnapshot = {
      frame: 0,
      playing: false,
      scrubbing: false,
      rate: 0,
      ctxTime: this.ctx.currentTime
    }
    this.reportedPlaying = false
    this.pendingPlaying = null
  }

  private emitState(): void {
    if (this.stateListeners.size === 0) return
    const snap = this.snapshot()
    for (const cb of this.stateListeners) cb(snap)
  }

  private post(command: DeckCommand, transfer?: ArrayBuffer[]): void {
    if (transfer && transfer.length > 0) this.node.port.postMessage(command, transfer)
    else this.node.port.postMessage(command)
  }
}
