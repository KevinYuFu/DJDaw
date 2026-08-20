import type { Clip } from '@shared/clips'
import { timelineDuration, toRegions } from '@shared/clips'
import {
  dbToGain,
  eqGainDb,
  filterSetting,
  flatChannel,
  trimGainDb,
  type ChannelEq,
  EQ_FREQUENCIES,
  EQ_MID_Q
} from '@shared/eq'
import {
  DECK_PROCESSOR_NAME,
  DECK_WORKLET_URL,
  type RegionFrames
} from '@renderer/audio/deckProtocol'

/**
 * Offline render of an edit: the whole MACRO timeline of every deck, summed
 * into one AudioBuffer, ready to be encoded with `@shared/wav`.
 *
 * This runs the *same* worklet and the *same* channel strip as live playback —
 * `deck-processor.js` inside an OfflineAudioContext, then trim, low, mid, high,
 * filter — which is the whole reason the engine was built the way it is. None
 * of the DSP is reimplemented here, so the file that comes out is what was
 * heard, not an approximation of it.
 *
 * What deliberately differs from `Deck`, and why:
 *   - Knobs are set as values at time 0 instead of ramped. The ramps exist so a
 *     hand on a knob does not click; starting a render mid-ramp would just fade
 *     the EQ in over the first few milliseconds of the file.
 *   - The deck fader is applied on the output node rather than posted to the
 *     worklet, whose gain glides towards its target from unity. The chain is
 *     linear, so the level is identical either way, but this way it is right
 *     from the first sample.
 *   - Master volume is not applied at all. It is a monitoring control; turning
 *     the speakers down must not turn the exported track down.
 */

/** One deck's contribution to the render. */
export interface DeckRenderSpec {
  /** The decoded source file. Not modified: its channel data is copied. */
  buffer: AudioBuffer
  /** The pieces this deck plays, in timeline order. Empty means the whole file. */
  clips: readonly Clip[]
  /** Trim, three-band EQ and filter positions. Defaults to flat. */
  eq?: ChannelEq
  /** Channel fader level, linear. Defaults to unity. */
  gain?: number
}

export interface RenderOptions {
  /** Every deck to mix in. One deck or four both work; they simply sum. */
  decks: readonly DeckRenderSpec[]
  /**
   * Render rate. Defaults to the first deck's file rate, because the deck
   * engine advances its playhead one source frame per context frame — the same
   * assumption live playback makes, where every buffer came from
   * `decodeAudioData` at the context rate.
   */
  sampleRate?: number
}

/**
 * Tail added after the last clip ends, in seconds.
 *
 * Running off the end of the timeline fades the deck out over a few
 * milliseconds so the stop does not click. Ending the render exactly on the
 * last clip would cut that fade off and put the click back.
 */
const RENDER_TAIL_SEC = 0.05

/**
 * Report interval, in render quanta, high enough that the worklet never sends
 * a state message. Nothing is watching a playhead here, and a five-minute
 * render at the live rate would post tens of thousands of messages at a port
 * with no reader.
 */
const NO_STATE_REPORTS = 1e9

/** Butterworth, matching the live filter knob in `Deck`. */
const FILTER_Q = Math.SQRT1_2

/** Stereo out, like every deck output. */
const RENDER_CHANNELS = 2

/** Timeline length of one deck: its clips, or the whole file when it has none. */
function deckDurationSec(spec: DeckRenderSpec): number {
  const timeline = timelineDuration(spec.clips)
  return timeline > 0 ? timeline : spec.buffer.duration
}

/**
 * Regions in frames, exactly as `Deck.setRegions` builds them: timeline start
 * and end, plus where in the file the piece reads from.
 */
function regionFrames(spec: DeckRenderSpec): RegionFrames[] {
  const sr = spec.buffer.sampleRate
  return toRegions(spec.clips)
    .map((r) => ({
      startFrame: Math.round(r.startSec * sr),
      endFrame: Math.round((r.startSec + r.durationSec) * sr),
      sourceOffsetFrame: Math.round(r.sourceOffsetSec * sr)
    }))
    .filter((r) => r.endFrame > r.startFrame)
}

/**
 * Build one deck's channel strip and hand its worklet the audio and the
 * timeline. Same node order and same mappings as `Deck`; see the note at the
 * top of this file for the deliberate differences.
 */
function buildDeck(ctx: OfflineAudioContext, spec: DeckRenderSpec): void {
  // Copies, always. `getChannelData` hands back a view onto the AudioBuffer's
  // own memory, and handing that over would risk the buffer the live decks and
  // the waveforms are still using.
  const channelCount = Math.min(spec.buffer.numberOfChannels, RENDER_CHANNELS)
  const channels: Float32Array[] = []
  for (let c = 0; c < channelCount; c++) channels.push(spec.buffer.getChannelData(c).slice())

  // Everything the processor needs goes through processorOptions, NOT the
  // port. An offline context renders as fast as it can while port messages are
  // delivered on the audio thread's queue, so a load posted from here can
  // arrive after the render has already finished — which produces a silent
  // file. processorOptions are cloned into the constructor before any
  // rendering, so the deck is ready on its very first quantum.
  const node = new AudioWorkletNode(ctx, DECK_PROCESSOR_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [RENDER_CHANNELS],
    processorOptions: {
      stems: [{ id: 'master', channels }],
      frames: spec.buffer.length,
      sampleRate: spec.buffer.sampleRate,
      regions: regionFrames(spec),
      reportInterval: NO_STATE_REPORTS,
      playing: true
    }
  })

  const eq = spec.eq ?? flatChannel()

  const trim = ctx.createGain()
  trim.gain.value = dbToGain(trimGainDb(eq.trim))

  const lowShelf = ctx.createBiquadFilter()
  lowShelf.type = 'lowshelf'
  lowShelf.frequency.value = EQ_FREQUENCIES.low
  // A biquad's `gain` is already in dB, so the mapped value goes straight in.
  lowShelf.gain.value = eqGainDb(eq.low)

  const midPeak = ctx.createBiquadFilter()
  midPeak.type = 'peaking'
  midPeak.frequency.value = EQ_FREQUENCIES.mid
  midPeak.Q.value = EQ_MID_Q
  midPeak.gain.value = eqGainDb(eq.mid)

  const highShelf = ctx.createBiquadFilter()
  highShelf.type = 'highshelf'
  highShelf.frequency.value = EQ_FREQUENCIES.high
  highShelf.gain.value = eqGainDb(eq.high)

  // One node for both filter modes, exactly as the live deck wires it. A
  // centred knob comes back from `filterSetting` as a low-pass parked above
  // hearing, which is inaudible, so there is no bypass case to special-case.
  const setting = filterSetting(eq.filter)
  const filter = ctx.createBiquadFilter()
  filter.type = setting.type
  filter.frequency.value = setting.frequency
  filter.Q.value = FILTER_Q

  const gain = spec.gain ?? 1
  const output = ctx.createGain()
  output.gain.value = Number.isFinite(gain) ? Math.max(0, gain) : 1

  node.connect(trim)
  trim.connect(lowShelf)
  lowShelf.connect(midPeak)
  midPeak.connect(highShelf)
  highShelf.connect(filter)
  filter.connect(output)
  output.connect(ctx.destination)

}

/**
 * Render an edit offline.
 *
 * Every deck is rendered into one context and they sum, so a single-deck edit
 * and a four-deck mashup take the same path. The result runs from timeline zero
 * to the end of the longest deck, plus a short fade tail.
 *
 * @throws RangeError if there is nothing to render.
 */
export async function renderTimeline(opts: RenderOptions): Promise<AudioBuffer> {
  const specs = opts.decks.filter((spec) => spec.buffer.length > 0)
  if (specs.length === 0) {
    throw new RangeError('renderTimeline: no decks to render')
  }

  const sampleRate = opts.sampleRate ?? specs[0].buffer.sampleRate
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`renderTimeline: bad sample rate ${sampleRate}`)
  }

  let durationSec = 0
  for (const spec of specs) {
    const deckDuration = deckDurationSec(spec)
    if (deckDuration > durationSec) durationSec = deckDuration
  }
  const length = Math.ceil((durationSec + RENDER_TAIL_SEC) * sampleRate)
  if (length <= 0) {
    throw new RangeError('renderTimeline: the timeline is empty')
  }

  const ctx = new OfflineAudioContext(RENDER_CHANNELS, length, sampleRate)
  // Worklet modules are registered per context, so the offline context loads
  // the same file the live engine does rather than inheriting anything.
  await ctx.audioWorklet.addModule(new URL(DECK_WORKLET_URL, window.location.href).href)

  for (const spec of specs) buildDeck(ctx, spec)

  return ctx.startRendering()
}
