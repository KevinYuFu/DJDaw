/**
 * Key detection, off the main thread.
 *
 * A whole track's worth of transforms is solid arithmetic, so it runs here and
 * the channels are transferred in. The analysis itself is `analysis/chroma`
 * and `shared/musicalKey`; this file only carries the audio between them.
 */

import { chromagram, downmix } from '@renderer/analysis/chroma'
import { keyFromChroma, type DetectedKey } from '@shared/musicalKey'

export interface KeyRequest {
  channels: Float32Array[]
  sampleRate: number
}

export type KeyWorkerMessage =
  | { type: 'done'; result: DetectedKey | null }
  | { type: 'error'; message: string }

// The renderer tsconfig loads both the DOM and WebWorker libs, so `self` is
// typed as a Window here. Narrowed once.
const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<KeyRequest>): void => {
  try {
    const { channels, sampleRate } = event.data
    const result = keyFromChroma(chromagram(downmix(channels), sampleRate))
    ctx.postMessage({ type: 'done', result } satisfies KeyWorkerMessage)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.postMessage({ type: 'error', message } satisfies KeyWorkerMessage)
  }
}
