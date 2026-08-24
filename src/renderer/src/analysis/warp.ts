import type { StretchRequest, StretchWorkerMessage } from './stretch.worker'

/**
 * Warp a file onto another tempo, keeping its pitch.
 *
 * A warped track is a second buffer the deck plays at its normal speed, so
 * nothing in the audio thread has to keep up with an FFT. The work happens in
 * a worker, because a four minute track takes seconds.
 */

/** Tempos within this of each other are treated as the same, and nothing is warped. */
const SAME_BPM = 0.01

/** How much longer the output has to be: above 1 is slower. */
export function warpFactor(fromBpm: number, toBpm: number): number {
  if (!(fromBpm > 0) || !(toBpm > 0)) return 1
  return fromBpm / toBpm
}

/** Whether a file at one tempo needs warping to reach another. */
export function needsWarp(fromBpm: number, toBpm: number): boolean {
  if (!(fromBpm > 0) || !(toBpm > 0)) return false
  return Math.abs(fromBpm - toBpm) > SAME_BPM
}

/**
 * A copy of `buffer` playing at `toBpm` instead of `fromBpm`.
 *
 * Hands the same buffer straight back when the two tempos already match.
 */
export async function warpBuffer(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  fromBpm: number,
  toBpm: number
): Promise<AudioBuffer> {
  if (!needsWarp(fromBpm, toBpm)) return buffer
  const factor = warpFactor(fromBpm, toBpm)

  // Copies, because the channel data is handed to the worker and comes back a
  // different object; the buffer the caller passed in stays as it was.
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice())

  const stretched = await new Promise<Float32Array[]>((resolve, reject) => {
    const worker = new Worker(new URL('./stretch.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<StretchWorkerMessage>) => {
      const message = event.data
      worker.terminate()
      if (message.type === 'done') resolve(message.channels)
      else reject(new Error(message.message))
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || 'stretch worker failed'))
    }
    const request: StretchRequest = { channels, factor }
    worker.postMessage(
      request,
      channels.map((c) => c.buffer)
    )
  })

  const out = ctx.createBuffer(
    stretched.length,
    stretched[0]?.length ?? 1,
    buffer.sampleRate
  )
  for (let c = 0; c < stretched.length; c++) out.getChannelData(c).set(stretched[c])
  return out
}
