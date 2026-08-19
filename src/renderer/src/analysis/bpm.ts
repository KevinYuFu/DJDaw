import type { BpmRequest, BpmWorkerMessage } from './bpm.worker'

/**
 * Tempo detection: main-thread wrapper around `bpm.worker.ts`.
 *
 * The analysis is a couple of seconds of solid arithmetic on a full track, so
 * it runs in a worker and the AudioBuffer's channels are transferred to it.
 */

export interface TempoResult {
  /** Detected tempo, rounded to two decimals the way rekordbox displays it. */
  bpm: number
  /** Seconds to the first downbeat at or after t=0. The grid's anchor time. */
  firstBeatTime: number
  /** 0-1: how far the winning tempo stood clear of its nearest rival. */
  confidence: number
}

/**
 * Detect tempo and the first downbeat of a decoded track.
 *
 * `onProgress` is called with 0-1 as the worker advances, for an import
 * progress bar; it is optional and never called after the promise settles.
 */
export function detectTempo(
  buffer: AudioBuffer,
  onProgress?: (ratio: number) => void
): Promise<TempoResult> {
  return new Promise<TempoResult>((resolve, reject) => {
    const worker = new Worker(new URL('./bpm.worker.ts', import.meta.url), { type: 'module' })
    let settled = false

    const settle = (): void => {
      settled = true
      worker.terminate()
    }

    worker.onmessage = (event: MessageEvent<BpmWorkerMessage>): void => {
      const msg = event.data
      if (msg.type === 'progress') {
        if (!settled) onProgress?.(msg.ratio)
        return
      }
      if (settled) return
      settle()
      if (msg.type === 'done') resolve(msg.result)
      else reject(new Error(msg.message))
    }

    worker.onerror = (event: ErrorEvent): void => {
      if (settled) return
      settle()
      reject(new Error(event.message || 'tempo analysis failed'))
    }

    // getChannelData hands back a view onto the AudioBuffer's own memory, so
    // transferring it straight to the worker would detach the buffer the deck
    // is playing from. Copy first.
    const channels: Float32Array[] = []
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      channels.push(buffer.getChannelData(c).slice())
    }

    const request: BpmRequest = { channels, sampleRate: buffer.sampleRate }
    worker.postMessage(
      request,
      channels.map((c) => c.buffer)
    )
  })
}
