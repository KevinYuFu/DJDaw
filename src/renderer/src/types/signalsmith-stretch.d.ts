declare module 'signalsmith-stretch' {
  /**
   * The bits of the Signalsmith Stretch node this app uses.
   *
   * It sits in a deck's chain as a live pitch shifter, so the tempo can move
   * without the pitch following it.
   */
  export interface StretchNode extends AudioNode {
    schedule(change: { active?: boolean; semitones?: number; output?: number }): void
    start(when?: number): void
    stop(when?: number): void
  }

  export default function SignalsmithStretch(
    context: BaseAudioContext,
    channelOptions?: Record<string, unknown>
  ): Promise<StretchNode>
}
