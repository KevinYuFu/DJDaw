import SignalsmithStretch, { type StretchNode } from 'signalsmith-stretch'
import {
  VOICE_PROCESSOR_NAME,
  type VoiceClip,
  type VoiceCommand
} from '@renderer/audio/voiceProtocol'

/**
 * One audio source playing inside one lane.
 *
 * A lane is the sum of its voices, which is how one lane holds clips from
 * several tracks. A voice reads one file at one speed, so its pitch shift is a
 * single constant.
 *
 *   worklet ──> stretcher ──> (lane)
 */
export class Voice {
  /** The source this voice plays, as a library track id. */
  readonly sourceId: string

  private readonly ctx: AudioContext
  private readonly node: AudioWorkletNode
  private readonly out: GainNode
  private stretch: StretchNode | null = null
  private stretchReady: Promise<void> | null = null
  /** Source frames per arrangement frame. */
  private rate = 1

  constructor(sourceId: string, ctx: AudioContext, destination: AudioNode) {
    this.sourceId = sourceId
    this.ctx = ctx
    this.node = new AudioWorkletNode(ctx, VOICE_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    })
    this.out = ctx.createGain()
    this.node.connect(this.out)
    this.out.connect(destination)
  }

  /** Hand the voice its audio. The channel data is copied, then transferred. */
  load(buffer: AudioBuffer): void {
    const channels: Float32Array[] = []
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
      channels.push(new Float32Array(buffer.getChannelData(c)))
    }
    this.post(
      { type: 'load', channels, frames: buffer.length },
      channels.map((c) => c.buffer)
    )
  }

  setClips(clips: VoiceClip[]): void {
    this.post({ type: 'clips', clips })
  }

  /**
   * How fast this voice reads its file, and the pitch shift that cancels it.
   *
   * The stretcher is inserted on the first warp and stays in the chain, so its
   * latency is the same for the life of the voice.
   */
  setRate(rate: number): void {
    const next = Number.isFinite(rate) && rate > 0 ? rate : 1
    if (next === this.rate && this.stretchReady) return
    this.rate = next
    this.post({ type: 'rate', rate: next })
    void this.applyShift()
  }

  private async applyShift(): Promise<void> {
    if (!this.stretchReady) {
      this.stretchReady = SignalsmithStretch(this.ctx)
        .then((node: StretchNode) => {
          this.stretch = node
          this.node.disconnect(this.out)
          this.node.connect(node)
          node.connect(this.out)
          node.start()
        })
        .catch((err: unknown) => {
          console.error('[voice] stretcher failed to start', err)
          this.stretchReady = null
        })
    }
    await this.stretchReady
    this.stretch?.schedule({ active: true, semitones: -12 * Math.log2(this.rate) })
  }

  /** Start on a named context frame, shared by every voice in the session. */
  start(fromFrame: number, atContextFrame: number): void {
    this.post({ type: 'transport', playing: true, fromFrame, atContextFrame })
  }

  stop(): void {
    this.post({ type: 'transport', playing: false })
  }

  seek(frame: number): void {
    this.post({ type: 'seek', frame })
  }

  dispose(): void {
    this.post({ type: 'transport', playing: false })
    this.stretch?.stop()
    this.node.disconnect()
    this.stretch?.disconnect()
    this.out.disconnect()
  }

  private post(msg: VoiceCommand, transfer: Transferable[] = []): void {
    this.node.port.postMessage(msg, transfer)
  }
}
