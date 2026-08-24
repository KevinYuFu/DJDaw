/// <reference lib="webworker" />
import { stretchChannels } from './stretch'

/**
 * Warping, off the main thread.
 *
 * Stretching a four minute track takes seconds, so it runs here rather than
 * freezing the window while a track is being warped onto the master tempo.
 */

export interface StretchRequest {
  channels: Float32Array[]
  /** Output length over input length: above 1 is longer and slower. */
  factor: number
}

export interface StretchDone {
  type: 'done'
  channels: Float32Array[]
}

export interface StretchFailed {
  type: 'error'
  message: string
}

export type StretchWorkerMessage = StretchDone | StretchFailed

self.onmessage = (event: MessageEvent<StretchRequest>): void => {
  try {
    const channels = stretchChannels(event.data.channels, event.data.factor)
    const done: StretchDone = { type: 'done', channels }
    ;(self as unknown as Worker).postMessage(
      done,
      channels.map((c) => c.buffer)
    )
  } catch (err) {
    const failed: StretchFailed = { type: 'error', message: String(err) }
    ;(self as unknown as Worker).postMessage(failed)
  }
}
