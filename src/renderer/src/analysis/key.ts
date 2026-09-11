/**
 * Key detection: main-thread wrapper around `key.worker.ts`.
 *
 * The answer is a guess from the audio, not a fact about it. Where rekordbox
 * already states a key, that one is used instead — see `keysFromMirror` in
 * `shared/collection`.
 */

import type { DetectedKey } from '@shared/musicalKey'
import type { KeyRequest, KeyWorkerMessage } from './key.worker'

/** Detect the key of a decoded track, or null when there is nothing to hear. */
export function detectKey(buffer: AudioBuffer): Promise<DetectedKey | null> {
  return new Promise<DetectedKey | null>((resolve, reject) => {
    const worker = new Worker(new URL('./key.worker.ts', import.meta.url), { type: 'module' })
    let settled = false

    const settle = (): void => {
      settled = true
      worker.terminate()
    }

    worker.onmessage = (event: MessageEvent<KeyWorkerMessage>): void => {
      if (settled) return
      settle()
      if (event.data.type === 'done') resolve(event.data.result)
      else reject(new Error(event.data.message))
    }

    worker.onerror = (event: ErrorEvent): void => {
      if (settled) return
      settle()
      reject(new Error(event.message || 'key analysis failed'))
    }

    // getChannelData hands back a view onto the AudioBuffer's own memory, so
    // transferring it straight to the worker would detach the buffer the deck
    // is playing from. Copy first.
    const channels: Float32Array[] = []
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      channels.push(buffer.getChannelData(c).slice())
    }

    const request: KeyRequest = { channels, sampleRate: buffer.sampleRate }
    worker.postMessage(
      request,
      channels.map((c) => c.buffer)
    )
  })
}
