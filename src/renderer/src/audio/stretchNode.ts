/**
 * The bits of the Signalsmith Stretch node this app uses.
 *
 * The library ships without types, and only a few of its methods are needed:
 * it sits in a deck's chain as a live pitch shifter, so the tempo can move
 * without the pitch following it.
 */
export interface StretchNode extends AudioNode {
  schedule(change: { active?: boolean; semitones?: number; output?: number }): void
  start(when?: number): void
  stop(when?: number): void
  latency(): number
}
