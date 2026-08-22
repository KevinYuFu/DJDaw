/**
 * Message protocol between the renderer and the deck AudioWorklet.
 * The worklet itself lives at `public/worklets/deck-processor.js` (plain JS so
 * it can be handed straight to `audioWorklet.addModule`); this file is the
 * typed contract both sides are written against.
 */

export const DECK_PROCESSOR_NAME = 'deck-processor'
export const DECK_WORKLET_URL = 'worklets/deck-processor.js'

/** One independently gain-controlled layer of a deck: the full mix, or a stem. */
export interface StemPayload {
  id: string
  /** One Float32Array per channel. Transferred, not copied. */
  channels: Float32Array[]
}

/**
 * One playable piece of a deck's timeline, in frames.
 *
 * `startFrame`/`endFrame` are TIMELINE positions — where the piece sits on the
 * row — and `sourceOffsetFrame` is where in the file it reads from. The two
 * only agree on an uncut deck.
 */
export interface RegionFrames {
  startFrame: number
  endFrame: number
  sourceOffsetFrame: number
  /**
   * Which audio this piece reads from. Left off, it is the deck's own track.
   *
   * A piece cut from one row and dropped on another keeps playing its own
   * audio, so a row is an arrangement of samples rather than a window onto a
   * single file.
   */
  sourceId?: string
}

export type DeckCommand =
  /** Hand the deck its audio. Replaces anything already loaded. */
  | { type: 'load'; id: string; stems: StemPayload[]; frames: number; sampleRate: number }
  /**
   * Audio a piece brought with it from another row. Never touches the
   * playhead: the row it landed on is still playing.
   */
  | { type: 'addSource'; id: string; stems: StemPayload[]; frames: number }
  /** Forget audio nothing on this row plays any more. */
  | { type: 'dropSource'; id: string }
  | { type: 'unload' }
  /** Start playback from the current position. */
  | { type: 'play' }
  /** Stop. The playhead lands exactly where it was when the command was sent. */
  | { type: 'pause' }
  /** Jump the playhead. Click-free: the engine crossfades across the splice. */
  | { type: 'seek'; frame: number }
  /** Playback speed, 1 = original tempo. Ramped, so tempo moves never zipper. */
  | { type: 'rate'; rate: number }
  /** Deck output level, 0-1+ linear. */
  | { type: 'gain'; gain: number }
  /** Level of one stem layer, 0-1 linear. */
  | { type: 'stemGain'; id: string; gain: number }
  | { type: 'loop'; enabled: boolean; startFrame: number; endFrame: number }
  /**
   * The pieces this deck plays, sorted and non-overlapping. Anything between
   * them is a gap and plays as silence while the playhead runs on. An empty
   * list means the whole file, straight through, which is what an uncut deck
   * sends.
   */
  | {
      type: 'regions'
      regions: RegionFrames[]
      /** The row's own length, when it is longer than the audio on it. */
      timelineFrames: number
    }
  /**
   * Enter/leave scrub mode. While scrubbing the playhead chases `scrubTarget`
   * and the deck sounds it out, the way a CDJ platter does in search mode.
   */
  | { type: 'scrub'; active: boolean }
  | { type: 'scrubTarget'; frame: number }
  /** How many 128-frame render quanta between state reports. */
  | { type: 'reportInterval'; quanta: number }

export type DeckEvent =
  | { type: 'loaded'; frames: number }
  | {
      type: 'state'
      /** Playhead in fractional frames. */
      frame: number
      playing: boolean
      scrubbing: boolean
      /** Effective playback rate, after smoothing. */
      rate: number
      /** `AudioContext.currentTime` when this state was sampled. */
      ctxTime: number
    }
  /** Playback ran off the end of the last region. */
  | { type: 'ended'; frame: number }
