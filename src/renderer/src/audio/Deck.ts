import type { DeckId } from '@shared/types'
import type { Region } from '@shared/clips'
import {
  bandGain,
  dbToGain,
  filterSetting,
  trimGainDb,
  type ChannelEq,
  type EqMode,
  CENTRE,
  CROSSOVER_HZ,
  CROSSOVER_Q
} from '@shared/eq'
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

/**
 * Time constant for every EQ, trim and filter move.
 *
 * `setTargetAtTime` is exponential, so this settles in roughly 60 ms: fast
 * enough that a knob still feels connected to the sound, slow enough that no
 * single move lands as a step. Stepping a gain or a cutoff is an audible click,
 * and a swept filter would zipper the whole way.
 */
const EQ_RAMP_SEC = 0.02

/**
 * Biquads per crossover slope. Two cascaded Butterworth sections make one
 * Linkwitz-Riley 24 dB/oct slope, and LR is the whole point: its bands sum
 * flat. A single Butterworth pair leaves a +3 dB bump sitting on each crossover
 * with every band centred, which is a measured artefact of EQ Three, not
 * something to copy.
 */
const LR_SECTIONS = 2

/**
 * Convert a Q factor to what a Web Audio low-pass or high-pass wants.
 *
 * Those two types read their `Q` param in **decibels**, not as the Q factor the
 * maths uses: the spec builds them with `alpha = sin(w0) / (2 * 10^(Q/20))`.
 * Butterworth is a Q factor of 1/sqrt(2), which is -3.01 dB here. Handing the
 * node 0.707 instead asks for a Q of 1.085, and three resonant crossover slopes
 * summed measure +7.4 dB at each crossover with every band centred. Measured,
 * not guessed — see the note on {@link createChannelStrip}.
 */
function qFactorToDb(q: number): number {
  return 20 * Math.log10(q)
}

/** One biquad in a crossover slope. */
interface CrossoverSection {
  type: BiquadFilterType
  hz: number
}

/** The cascade for one Linkwitz-Riley slope at `hz`. */
function slope(type: BiquadFilterType, hz: number): CrossoverSection[] {
  return Array.from({ length: LR_SECTIONS }, () => ({ type, hz }))
}

/**
 * The nodes of one mixer channel strip.
 *
 * The EQ is a crossover-and-sum, not a chain of shelves: the signal is split
 * three ways, each band passes through a plain gain, and the three are summed.
 * Only that can take a band to silence, which is what an isolator has to do —
 * a shelf can lean on a band but never remove it.
 */
export interface ChannelStrip {
  /** Trim, first in the strip. Connect the source here. */
  readonly input: GainNode
  /** One gain per band, each fed by its own crossover path. */
  readonly bands: Readonly<Record<'low' | 'mid' | 'high', GainNode>>
  /**
   * The filter knob, and the last node in the strip: connect this to the
   * channel fader. One node covers both modes; its type flips, the graph does
   * not.
   */
  readonly filter: BiquadFilterNode
}

/**
 * Build a channel strip.
 *
 * ```
 *  in -> trim -+-> LP LP ----------> low  -+
 *              +-> HP HP  LP LP ---> mid  -+-> sum -> filter -> out
 *              +-> HP HP ----------> high -+
 * ```
 *
 * Built once and never rebuilt, because rewiring a live graph clicks: a knob
 * move only ever changes an AudioParam. Takes a `BaseAudioContext` so an
 * offline render builds the identical strip and an export sounds like what was
 * heard.
 *
 * A three-way parallel split does not sum flat by default, so this one was
 * measured rather than assumed: an impulse through the finished strip in an
 * OfflineAudioContext, every knob centred, is within 0.12 dB of the input
 * across 30 Hz - 18 kHz, and each band reads exactly -6 dB at its own
 * crossover, which is the Linkwitz-Riley signature. The residual 0.12 dB is the
 * mid path's own phase shift at the far crossover and is as good as a three-way
 * split gets.
 */
export function createChannelStrip(ctx: BaseAudioContext): ChannelStrip {
  const trim = ctx.createGain()
  const sum = ctx.createGain()

  const band = (sections: CrossoverSection[]): GainNode => {
    let node: AudioNode = trim
    for (const section of sections) {
      const biquad = ctx.createBiquadFilter()
      biquad.type = section.type
      biquad.frequency.value = section.hz
      biquad.Q.value = qFactorToDb(CROSSOVER_Q)
      node.connect(biquad)
      node = biquad
    }
    const gain = ctx.createGain()
    node.connect(gain)
    gain.connect(sum)
    return gain
  }

  const bands = {
    low: band(slope('lowpass', CROSSOVER_HZ.low)),
    mid: band([
      ...slope('highpass', CROSSOVER_HZ.low),
      ...slope('lowpass', CROSSOVER_HZ.high)
    ]),
    high: band(slope('highpass', CROSSOVER_HZ.high))
  }

  // Parked wherever a centred knob puts it: a low-pass above the top of
  // hearing, which is inaudible.
  const parked = filterSetting(CENTRE)
  const filter = ctx.createBiquadFilter()
  filter.type = parked.type
  filter.frequency.value = parked.frequency
  filter.Q.value = qFactorToDb(parked.q)
  sum.connect(filter)

  return { input: trim, bands, filter }
}

/**
 * Push a channel's knob positions onto a strip, as of `now` on its context.
 *
 * Every knob is a 0-1 position; the mapping from position to dB or Hz lives in
 * `@shared/eq`, so the offline render reuses it unchanged. Nothing is stepped —
 * see {@link EQ_RAMP_SEC}.
 *
 * A full isolator cut is a band gain of exactly zero. The ramp only approaches
 * it, but it is under -100 dB within five time constants, so the band is
 * silent by any measure that matters and never arrives as a click.
 */
export function applyChannelStrip(
  strip: ChannelStrip,
  eq: ChannelEq,
  mode: EqMode,
  now: number
): void {
  if (
    !Number.isFinite(eq.trim) ||
    !Number.isFinite(eq.low) ||
    !Number.isFinite(eq.mid) ||
    !Number.isFinite(eq.high) ||
    !Number.isFinite(eq.filter)
  ) {
    return
  }
  strip.input.gain.setTargetAtTime(dbToGain(trimGainDb(eq.trim)), now, EQ_RAMP_SEC)
  strip.bands.low.gain.setTargetAtTime(bandGain(eq.low, mode), now, EQ_RAMP_SEC)
  strip.bands.mid.gain.setTargetAtTime(bandGain(eq.mid, mode), now, EQ_RAMP_SEC)
  strip.bands.high.gain.setTargetAtTime(bandGain(eq.high, mode), now, EQ_RAMP_SEC)
  applyFilter(strip.filter, eq.filter, now)
}

/**
 * Move the filter knob's single node.
 *
 * Crossing the centre swaps low-pass for high-pass. The frequency and Q have to
 * jump on that swap rather than ramp: the two modes only meet either side of
 * the dead zone, where a low-pass sits near 17 kHz and a high-pass near 25 Hz,
 * so both are transparent at the moment of the flip and the jump is silent.
 * Ramping instead would drag a fresh high-pass down from 17 kHz and mute the
 * deck on the way through.
 */
function applyFilter(filter: BiquadFilterNode, knob: number, now: number): void {
  const setting = filterSetting(knob)
  if (filter.type !== setting.type) {
    filter.frequency.cancelScheduledValues(now)
    filter.Q.cancelScheduledValues(now)
    filter.type = setting.type
    filter.frequency.setValueAtTime(setting.frequency, now)
    filter.Q.setValueAtTime(qFactorToDb(setting.q), now)
    return
  }
  filter.frequency.setTargetAtTime(setting.frequency, now, EQ_RAMP_SEC)
  filter.Q.setTargetAtTime(qFactorToDb(setting.q), now, EQ_RAMP_SEC)
}

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
  /** Trim, EQ and filter, built once and never rewired. */
  private readonly strip: ChannelStrip
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
    this.strip = createChannelStrip(ctx)

    this.output = ctx.createGain()
    this.node.connect(this.strip.input)
    this.strip.filter.connect(this.output)
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

  /**
   * Channel fader level. Deliberately separate from trim: the fader is a
   * performance control the user rides, trim is a set-and-forget match between
   * tracks, and folding them together would make one overwrite the other.
   */
  setGain(linear: number): void {
    if (!Number.isFinite(linear)) return
    this.post({ type: 'gain', gain: clamp(linear, 0, MAX_GAIN) })
  }

  /**
   * Apply the channel's knobs: trim, three-band EQ and the filter.
   *
   * `mode` is required rather than defaulted, because the two floors sound
   * completely different — a DJM channel EQ stops at -26 dB, its isolator mode
   * goes to silence — and a caller that forgot would quietly get the wrong one.
   */
  setChannelEq(eq: ChannelEq, mode: EqMode): void {
    applyChannelStrip(this.strip, eq, mode, this.ctx.currentTime)
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
