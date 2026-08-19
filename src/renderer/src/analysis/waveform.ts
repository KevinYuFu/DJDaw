/**
 * Waveform analysis and the on-disk cache format.
 *
 * The DSP lives in `waveform.worker.ts`; this module owns the worker and the
 * `.djw` encoding written to `<userData>/waveforms/<trackId>.djw`, so the rest
 * of the app never has to know either.
 */

import type { WaveformData, WaveformMeta } from '@shared/types'
import { WAVEFORM_CACHE_VERSION } from '@renderer/core/constants'
import type { WaveformRequest, WaveformWorkerMessage } from './waveform.worker'

/** File magic, 'DJW1' in ASCII. */
const MAGIC = [0x44, 0x4a, 0x57, 0x31]
/** Magic plus the uint32 header length. */
const HEADER_OFFSET = 8

/**
 * Analyse a decoded track into its three-band peak envelope.
 *
 * A worker is spawned per call and terminated as soon as the job settles, which
 * keeps concurrent analyses independent — importing a folder runs several at
 * once. `onProgress` is called with 0-1 roughly forty times per file, for the
 * analysing bar.
 */
export function analyzeWaveform(
  buffer: AudioBuffer,
  onProgress?: (ratio: number) => void
): Promise<WaveformData> {
  // getChannelData hands back a view onto the AudioBuffer's own memory, and
  // transferring that would detach the buffer the deck is playing from. Copy.
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c).slice())
  }
  const request: WaveformRequest = { channels, sampleRate: buffer.sampleRate }

  return new Promise<WaveformData>((resolve, reject) => {
    const worker = new Worker(new URL('./waveform.worker.ts', import.meta.url), { type: 'module' })

    worker.onmessage = (event: MessageEvent<WaveformWorkerMessage>): void => {
      const msg = event.data
      if (msg.type === 'progress') {
        onProgress?.(msg.ratio)
        return
      }
      worker.terminate()
      if (msg.type === 'error') {
        reject(new Error(msg.message))
        return
      }
      resolve({
        version: WAVEFORM_CACHE_VERSION,
        bucketSize: msg.bucketSize,
        bucketCount: msg.bucketCount,
        sampleRate: msg.sampleRate,
        peak: msg.peak,
        low: msg.low,
        mid: msg.mid,
        high: msg.high
      })
    }

    worker.onerror = (event: ErrorEvent): void => {
      worker.terminate()
      reject(new Error(event.message || 'waveform worker failed'))
    }

    worker.postMessage(
      request,
      channels.map((c) => c.buffer)
    )
  })
}

/** Serialise to the `.djw` cache format. */
export function encodeWaveform(w: WaveformData): ArrayBuffer {
  const meta: WaveformMeta = {
    version: w.version,
    bucketSize: w.bucketSize,
    sampleRate: w.sampleRate,
    bucketCount: w.bucketCount,
    peak: w.peak
  }
  const header = new TextEncoder().encode(JSON.stringify(meta))
  const n = w.bucketCount

  const out = new ArrayBuffer(HEADER_OFFSET + header.length + n * 3)
  const bytes = new Uint8Array(out)
  bytes.set(MAGIC, 0)
  new DataView(out).setUint32(4, header.length, true)
  bytes.set(header, HEADER_OFFSET)

  let offset = HEADER_OFFSET + header.length
  for (const band of [w.low, w.mid, w.high]) {
    bytes.set(band.subarray(0, n), offset)
    offset += n
  }
  return out
}

/**
 * Parse a `.djw` cache. Returns null for anything unreadable — wrong magic, a
 * version bump, a truncated file — so a stale or corrupt cache is silently
 * re-analysed instead of taking the import down with it.
 */
export function decodeWaveform(data: ArrayBuffer): WaveformData | null {
  if (data.byteLength < HEADER_OFFSET) return null
  const bytes = new Uint8Array(data)
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return null
  }

  const headerLength = new DataView(data).getUint32(4, true)
  const bodyStart = HEADER_OFFSET + headerLength
  if (bodyStart > data.byteLength) return null

  let meta: Partial<WaveformMeta>
  try {
    meta = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_OFFSET, bodyStart)))
  } catch {
    return null
  }
  if (!meta || meta.version !== WAVEFORM_CACHE_VERSION) return null

  const n = meta.bucketCount
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null
  if (data.byteLength - bodyStart < n * 3) return null
  if (typeof meta.bucketSize !== 'number' || typeof meta.sampleRate !== 'number') return null

  // slice, not subarray: three independent arrays, none of them pinning the
  // whole cache buffer alive for the lifetime of the deck.
  return {
    version: meta.version,
    bucketSize: meta.bucketSize,
    sampleRate: meta.sampleRate,
    bucketCount: n,
    peak: typeof meta.peak === 'number' ? meta.peak : 0,
    low: bytes.slice(bodyStart, bodyStart + n),
    mid: bytes.slice(bodyStart + n, bodyStart + n * 2),
    high: bytes.slice(bodyStart + n * 2, bodyStart + n * 3)
  }
}
