/**
 * Message protocol between the renderer and the arrangement voice AudioWorklet.
 * The worklet itself lives at `public/worklets/voice-processor.js` (plain JS so
 * it can be handed straight to `audioWorklet.addModule`); this file is the
 * typed contract both sides are written against.
 */

export const VOICE_PROCESSOR_NAME = 'voice-processor'
export const VOICE_WORKLET_URL = 'worklets/voice-processor.js'

/**
 * One piece of a source on the arrangement, in frames.
 *
 * `start` and `end` are arrangement positions — where the piece sits on the
 * grid — and `src` is the source frame it begins reading at. A warped clip
 * covers more or fewer source frames than arrangement frames; the voice's rate
 * is what converts between them.
 */
export interface VoiceClip {
  start: number
  end: number
  src: number
}

export type VoiceCommand =
  /** Hand the voice its audio. Channels are transferred, not copied. */
  | { type: 'load'; channels: Float32Array[]; frames: number }
  /** The pieces this voice plays, in arrangement order, never overlapping. */
  | { type: 'clips'; clips: VoiceClip[] }
  /** Source frames consumed per arrangement frame. 1 plays at file tempo. */
  | { type: 'rate'; rate: number }
  /**
   * Start or stop.
   *
   * A start names the context frame to begin on, so voices created at
   * different moments still take their first sample on the same one.
   */
  | { type: 'transport'; playing: true; fromFrame: number; atContextFrame: number }
  | { type: 'transport'; playing: false }
  /** Jump the playhead. Click-free: the voice crossfades across the splice. */
  | { type: 'seek'; frame: number }

