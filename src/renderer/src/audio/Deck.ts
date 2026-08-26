import type { DeckId } from '@shared/types'
import type { Region } from '@shared/clips'
import {
  bandGain,
  dbToGain,
  eqGainDb,
  filterSetting,
  trimGainDb,
  type ChannelEq,
  type EqMode,
  CENTRE,
  CROSSOVER_HZ,
  CROSSOVER_Q,
  MID_BELL_HZ,
  MID_BELL_Q,
  SHELF_CORNER_HZ
} from '@shared/eq'
import SignalsmithStretch, { type StretchNode } from 'signalsmith-stretch'
import { clamp } from '@renderer/core/format'
import {
  DECK_PROCESSOR_NAME,
  type DeckCommand,
  type DeckEvent,
  type RegionFrames
} from '@renderer/audio/deckProtocol'
import { audibleTime, outputLatencySec } from '@shared/latency'

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

/** Rate floor, the same distance the other way. */
const MIN_RATE = 1 / MAX_RATE

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
 * Crossfade between the EQ and ISO paths, in seconds.
 *
 * The two paths have different phase responses, so the change is faded rather
 * than cut.
 */
const MODE_XFADE_SEC = 0.03

/**
 * Biquads per crossover slope. Two cascaded Butterworth sections make one
 * Linkwitz-Riley 24 dB/oct slope, whose bands sum flat. A single Butterworth
 * pair leaves a +3 dB bump on each crossover with every band centred.
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
 * Two EQ circuits sit side by side:
 *
 *   EQ mode   three shelving/bell filters in series. At 0 dB each is an
 *             identity, so a centred channel is transparent. Its floor is
 *             -26 dB; it cannot reach silence.
 *   ISO mode  a crossover-and-sum. Takes a band to nothing, and rotates phase
 *             between the bands whatever the knobs say.
 *
 * Both are built once and both stay wired. The mode crossfades their gates,
 * at a cost of three idle biquads per deck.
 */
export interface ChannelStrip {
  /** Trim, first in the strip. Connect the source here. */
  readonly input: GainNode
  /** EQ mode: low shelf, mid bell, high shelf, in series. */
  readonly shelves: Readonly<Record<'low' | 'mid' | 'high', BiquadFilterNode>>
  /** ISO mode: one gain per band, each fed by its own crossover path. */
  readonly bands: Readonly<Record<'low' | 'mid' | 'high', GainNode>>
  /** Gate on the shelf path. 1 in EQ mode, 0 in ISO mode. */
  readonly shelfGain: GainNode
  /** Gate on the crossover path. 1 in ISO mode, 0 in EQ mode. */
  readonly isoGain: GainNode
  /**
   * The filter knob, and the last node in the strip: connect this to the
   * channel fader. One node covers both modes; its type flips, the graph does
   * not.
   */
  readonly filter: BiquadFilterNode
  /**
   * The mode currently gated in, or null before the first apply.
   *
   * Mutable: {@link applyChannelStrip} reads it to tell a mode change from a
   * knob move, and runs the crossfade once per change.
   */
  mode: EqMode | null
}

/**
 * Build a channel strip.
 *
 * ```
 *          +-> lowshelf -> bell -> highshelf ---> shelfGain -+
 *  in -> trim                                                +-> filter -> out
 *          |  +-> LP LP ----------> low  -+                  |
 *          +--+-> HP HP  LP LP ---> mid  -+-> sum -> isoGain -+
 *             +-> HP HP ----------> high -+
 * ```
 *
 * Built once and never rebuilt: a knob move only ever changes an AudioParam.
 * Takes a `BaseAudioContext`, so an offline render builds the identical strip.
 *
 * The crossover is Linkwitz-Riley: its bands sum flat, within 0.12 dB across
 * 30 Hz - 18 kHz, each reading -6 dB at its own crossover. It still rotates
 * phase between the bands, so EQ mode is not built from it.
 */
export function createChannelStrip(ctx: BaseAudioContext): ChannelStrip {
  const trim = ctx.createGain()

  // EQ mode. Shelving and peaking filters read `Q` as a real Q factor, not in
  // decibels the way a low-pass does, so qFactorToDb must not be used here.
  // A shelf ignores Q outright; only the bell's is load-bearing.
  const shelf = (type: BiquadFilterType, hz: number, q: number): BiquadFilterNode => {
    const node = ctx.createBiquadFilter()
    node.type = type
    node.frequency.value = hz
    node.Q.value = q
    node.gain.value = 0
    return node
  }
  const shelves = {
    low: shelf('lowshelf', SHELF_CORNER_HZ.low, Math.SQRT1_2),
    mid: shelf('peaking', MID_BELL_HZ, MID_BELL_Q),
    high: shelf('highshelf', SHELF_CORNER_HZ.high, Math.SQRT1_2)
  }
  const shelfGain = ctx.createGain()
  trim.connect(shelves.low)
  shelves.low.connect(shelves.mid)
  shelves.mid.connect(shelves.high)
  shelves.high.connect(shelfGain)

  // ISO mode.
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
  const isoGain = ctx.createGain()
  sum.connect(isoGain)

  // EQ is the app's default mode, and it is also the safe one to sit in until
  // the first apply: flat shelves pass the signal through untouched.
  shelfGain.gain.value = 1
  isoGain.gain.value = 0

  // Parked as an identity: see {@link FILTER_BYPASS_TYPE}. `gain` is only read
  // by the peaking type and is left at its default 0 for the whole session,
  // which is what makes the parked state exact.
  const parked = filterSetting(CENTRE)
  const filter = ctx.createBiquadFilter()
  filter.type = FILTER_BYPASS_TYPE
  filter.frequency.value = parked.frequency
  filter.Q.value = parked.q
  shelfGain.connect(filter)
  isoGain.connect(filter)

  return { input: trim, shelves, bands, shelfGain, isoGain, filter, mode: null }
}

/**
 * Push a channel's knob positions onto a strip, as of `now` on its context.
 *
 * Every knob is a 0-1 position; the mapping from position to dB or Hz lives in
 * `@shared/eq`, so the offline render reuses it unchanged. Nothing a hand can
 * move is stepped — see {@link EQ_RAMP_SEC}.
 *
 * `mode` picks the path, and each path carries its own floor: the shelves stop
 * at -26 dB, the crossover reaches a band gain of zero. The ramp approaches
 * that zero, passing -100 dB within five time constants.
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

  const switching = strip.mode !== mode
  const first = strip.mode === null
  const incoming = mode === 'eq' ? strip.shelfGain : strip.isoGain
  // An inaudible path — muted, or on a strip nothing has played through — is
  // stepped into place, so it holds no stale positions when the mode returns to
  // it and an offline render is exact on its first sample. A path caught part
  // way up by a second mode change is audible, and ramps.
  const step = switching && (first || incoming.gain.value === 0)

  if (switching) {
    strip.mode = mode
    // Equal-gain, not equal-power: mid-fade both paths carry nearly the same
    // signal, so their sum holds at unity. The first apply snaps.
    gate(strip.shelfGain.gain, mode === 'eq' ? 1 : 0, now, !first)
    gate(strip.isoGain.gain, mode === 'eq' ? 0 : 1, now, !first)
  }

  // Trim and the filter knob are shared by both paths, so they always ramp.
  strip.input.gain.setTargetAtTime(dbToGain(trimGainDb(eq.trim)), now, EQ_RAMP_SEC)
  // Only the live path is worth the parameter ramps. The muted one is left
  // alone until the mode comes back to it.
  if (mode === 'eq') {
    setParam(strip.shelves.low.gain, eqGainDb(eq.low, 'eq'), now, step)
    setParam(strip.shelves.mid.gain, eqGainDb(eq.mid, 'eq'), now, step)
    setParam(strip.shelves.high.gain, eqGainDb(eq.high, 'eq'), now, step)
  } else {
    setParam(strip.bands.low.gain, bandGain(eq.low, 'isolator'), now, step)
    setParam(strip.bands.mid.gain, bandGain(eq.mid, 'isolator'), now, step)
    setParam(strip.bands.high.gain, bandGain(eq.high, 'isolator'), now, step)
  }
  applyFilter(strip.filter, eq.filter, now)
}

/** Ramp a parameter towards `value`, or step it when the path is silent. */
function setParam(param: AudioParam, value: number, now: number, step: boolean): void {
  if (!step) {
    param.setTargetAtTime(value, now, EQ_RAMP_SEC)
    return
  }
  param.cancelScheduledValues(now)
  param.setValueAtTime(value, now)
}

/** Move a path's gate to `target`, crossfading unless told to snap. */
function gate(param: AudioParam, target: number, now: number, ramp: boolean): void {
  // Read before cancelling: cancelScheduledValues drops a ramp in flight and
  // the parameter falls back to where that ramp started, not where it had got
  // to, so a second mode change inside the crossfade would jump.
  const current = param.value
  param.cancelScheduledValues(now)
  if (!ramp) {
    param.setValueAtTime(target, now)
    return
  }
  param.setValueAtTime(current, now)
  param.linearRampToValueAtTime(target, now + MODE_XFADE_SEC)
}

/**
 * What a bypassed filter knob parks on.
 *
 * A peaking biquad at 0 dB has numerator coefficients identical to its
 * denominator, so it is an exact identity whatever its frequency and Q. Parking
 * on a low-pass above the audible range is not: at 22 kHz it still rotates
 * phase across the top of the band, which measured +0.53 dB of peak growth on a
 * loud master with every knob centred — as much as the old crossover EQ was
 * blamed for. It is worse at 44.1 kHz, where the node is clamped to Nyquist.
 */
const FILTER_BYPASS_TYPE: BiquadFilterType = 'peaking'

/**
 * Move the filter knob's single node.
 *
 * The type changes when the knob enters or leaves the dead zone, and again if
 * it is thrown across centre. Frequency and Q jump on that swap: it happens at
 * the edge of the dead zone, where the low-pass sits near 17 kHz and the
 * high-pass near 26 Hz and both are transparent.
 */
function applyFilter(filter: BiquadFilterNode, knob: number, now: number): void {
  const setting = filterSetting(knob)
  const type = setting.bypassed ? FILTER_BYPASS_TYPE : setting.type
  // Only a low-pass and a high-pass read Q in decibels. A peaking filter's Q is
  // a real Q factor, so the parked state must not be converted.
  const q = type === FILTER_BYPASS_TYPE ? setting.q : qFactorToDb(setting.q)
  if (filter.type !== type) {
    filter.frequency.cancelScheduledValues(now)
    filter.Q.cancelScheduledValues(now)
    filter.type = type
    filter.frequency.setValueAtTime(setting.frequency, now)
    filter.Q.setValueAtTime(q, now)
    return
  }
  filter.frequency.setTargetAtTime(setting.frequency, now, EQ_RAMP_SEC)
  filter.Q.setTargetAtTime(q, now, EQ_RAMP_SEC)
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
  /** How much faster the file is read to sit on the master tempo. */
  private warpRatio = 1
  /** How much faster the file is read for the tempo fader. */
  private pitchRatio = 1
  private stretch: StretchNode | null = null
  private stretchReady: Promise<void> | null = null

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

    // Pin the report rate, so extrapolation accuracy is set here.
    this.post({ type: 'reportInterval', quanta: STATE_REPORT_QUANTA })
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Hand the deck its audio. The channel data is copied and the copies
   * transferred, leaving the AudioBuffer intact for analysis and export.
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

  /** The warp alone, without the tempo fader: what a readout has to multiply by. */
  get warpRate(): number {
    return this.warpRatio
  }

  /**
   * Play at a different tempo without moving the pitch.
   *
   * The deck reads its file faster or slower, which is what puts its beats on
   * the master grid, and a stretcher after it puts the pitch back. Both are
   * live: nothing is re-rendered, so the tempo can be changed while the deck is
   * playing and it keeps playing.
   *
   * `rate` is how fast to read the file: a 174 track on a 150 master runs at
   * 0.86, and the stretcher shifts it back up by the same amount.
   */
  setWarp(rate: number): void {
    // Clamped here, so the shift that cancels it uses the speed actually run.
    const next = Number.isFinite(rate) && rate > 0 ? clamp(rate, MIN_RATE, MAX_RATE) : 1
    this.warpRatio = next
    this.applyRate()
    void this.applyWarp()
  }

  /**
   * Put a stretcher in front of the channel strip, once.
   *
   * Every warped deck keeps one even at its own tempo, so its latency is the
   * same as its neighbours'.
   */
  private async applyWarp(): Promise<void> {
    if (!this.stretchReady) {
      this.stretchReady = SignalsmithStretch(this.ctx)
        .then((node: StretchNode) => {
          this.stretch = node
          this.node.disconnect(this.strip.input)
          this.node.connect(node)
          node.connect(this.strip.input)
          node.start()
        })
        .catch((err: unknown) => {
          console.error('[deck] stretcher failed to start', err)
          this.stretchReady = null
        })
    }
    await this.stretchReady
    // The shift that cancels the speed change.
    this.stretch?.schedule({ active: true, semitones: -12 * Math.log2(this.warpRatio) })
  }

  /** Drop the audio and report an empty deck to every listener. */
  unload(): void {
    this.post({ type: 'unload' })
    this.frames = 0
    this.durationSec = 0
    this.sourceDurationSec = 0
    this.regions = []
    this.fileSampleRate = this.ctx.sampleRate
    this.warpRatio = 1
    this.applyRate()
    this.stretch?.schedule({ semitones: 0 })
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
    if (this.renderFrame() >= this.timelineFrames() - 1) {
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
      // The queued audio still reaches the speakers, so freeze on the render
      // clock; freezing on the audible one would replay what was already heard.
      frame: this.renderFrame(),
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
    return this.frameAt(audibleTime(this.ctx.currentTime, outputLatencySec(this.ctx)))
  }

  /**
   * Where the render clock has reached, in timeline frames. The worklet and
   * the device queue count from this; the playhead does not.
   */
  private renderFrame(): number {
    return this.frameAt(this.ctx.currentTime)
  }

  /** The frame the deck is at on the context clock at `at`. */
  private frameAt(at: number): number {
    const snap = this.lastSnapshot
    let frame = snap.frame
    if (snap.rate !== 0) {
      frame += (at - snap.ctxTime) * snap.rate * this.fileSampleRate
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

  /** 1 = the deck's own tempo. The worklet ramps to it, so moves never zipper. */
  setPitchRate(rate: number): void {
    if (!Number.isFinite(rate)) return
    this.pitchRatio = rate
    this.applyRate()
  }

  /**
   * The one place the read rate is written.
   *
   * The warp and the tempo fader are separate controls on the same speed and
   * multiply, so the fader moves a warped deck around the master tempo.
   */
  private applyRate(): void {
    this.post({ type: 'rate', rate: clamp(this.warpRatio * this.pitchRatio, 0, MAX_RATE) })
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
   * `mode` is required: the two floors differ, -26 dB against silence.
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
