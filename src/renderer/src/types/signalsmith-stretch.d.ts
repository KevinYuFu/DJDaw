declare module 'signalsmith-stretch' {
  import type { StretchNode } from '@renderer/audio/stretchNode'
  export default function SignalsmithStretch(
    context: BaseAudioContext,
    channelOptions?: Record<string, unknown>
  ): Promise<StretchNode>
}
