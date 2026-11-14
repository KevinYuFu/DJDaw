/**
 * Splitting a track into stems.
 *
 * The separation runs in `stemSplit.worker.ts`, so the UI keeps drawing while it
 * works. The model is an ONNX graph run by ONNX Runtime, on the GPU through
 * WebGPU where it can and on the CPU through WASM where it cannot. Nothing
 * leaves the machine: the model file ships with the app and is read off disk.
 *
 * If WebGPU fails, the split is run again on WASM in a fresh worker, and WebGPU
 * is not tried again until the app restarts. A fresh worker, because a runtime
 * whose WebGPU start-up failed is not safe to reuse.
 *
 * The model reads a segment of audio at a time along with its spectrogram, and
 * returns one waveform and one set of spectrogram masks per stem. Turning
 * audio into a spectrogram and back is `demucs-web`, which carries the exact
 * conventions the model was trained with.
 */
import { STEM_NAMES, STEM_SAMPLE_RATE, type StemName } from '@shared/stems'
import {
  backendOrder,
  freshBackendMemory,
  runWithFallback,
  type StemBackend
} from './stemBackend'
import type { StemSplitMessage, StemSplitRequest } from './stemSplit.worker'

export type { StemBackend } from './stemBackend'

/** One stem's audio, at {@link STEM_SAMPLE_RATE}. */
export interface StemAudio {
  left: Float32Array
  right: Float32Array
}

interface Pending {
  resolve: (stems: Record<StemName, StemAudio>) => void
  reject: (err: Error) => void
  onProgress: (ratio: number) => void
}

const memory = freshBackendMemory()
let gpuOffered: Promise<boolean> | null = null
let worker: Worker | null = null
/** Whether the live worker has been sent the model. */
let modelSent = false
let nextId = 1
const pending = new Map<number, Pending>()

interface GpuCapable {
  gpu?: { requestAdapter(): Promise<unknown | null> }
}

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & GpuCapable).gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) !== null
  } catch {
    return false
  }
}

/** Stop the worker and fail whatever was waiting on it. The next split starts a new one. */
function reset(err: Error): void {
  worker?.terminate()
  worker = null
  modelSent = false
  for (const job of pending.values()) job.reject(err)
  pending.clear()
}

/** The worker, kept between splits so the model is only loaded once. */
function stemWorker(): Worker {
  if (worker) return worker
  const made = new Worker(new URL('./stemSplit.worker.ts', import.meta.url), { type: 'module' })
  made.onmessage = (event: MessageEvent<StemSplitMessage>): void => {
    const msg = event.data
    const job = pending.get(msg.id)
    if (!job) return
    if (msg.type === 'progress') {
      job.onProgress(msg.ratio)
      return
    }
    pending.delete(msg.id)
    if (msg.type === 'error') job.reject(new Error(msg.message))
    else job.resolve(msg.stems)
  }
  made.onerror = (event: ErrorEvent): void => {
    reset(new Error(event.message || 'stem split failed'))
  }
  worker = made
  modelSent = false
  return made
}

/**
 * The track resampled to the rate the model works at, split into channels.
 *
 * A mono file is played into both channels, which is what the model expects.
 */
async function atModelRate(buffer: AudioBuffer): Promise<[Float32Array, Float32Array]> {
  const frames = Math.max(1, Math.round(buffer.duration * STEM_SAMPLE_RATE))
  const ctx = new OfflineAudioContext(2, frames, STEM_SAMPLE_RATE)
  const node = ctx.createBufferSource()
  node.buffer = buffer
  node.connect(ctx.destination)
  node.start()
  const at = await ctx.startRendering()
  return [at.getChannelData(0), at.getChannelData(1)]
}

/** Run one split in the worker on `backend`. The audio is copied, so it can be sent again. */
async function splitInWorker(
  backend: StemBackend,
  left: Float32Array,
  right: Float32Array,
  onProgress: (ratio: number) => void
): Promise<Record<StemName, StemAudio>> {
  const target = stemWorker()
  const model = modelSent ? undefined : await window.api.readStemModel()
  if (target !== worker) throw new Error('stem split was interrupted')
  modelSent = true

  const id = nextId++
  const request: StemSplitRequest = {
    type: 'split',
    id,
    backend,
    left: left.slice(),
    right: right.slice(),
    // Absolute, because the runtime imports these as modules by name.
    wasmPaths: new URL('ort/', window.location.href).href,
    model
  }
  const transfer: ArrayBuffer[] = [request.left.buffer as ArrayBuffer, request.right.buffer as ArrayBuffer]
  if (model) transfer.push(model)

  const stems = await new Promise<Record<StemName, StemAudio>>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress })
    target.postMessage(request, transfer)
  })
  for (const name of STEM_NAMES) {
    if (!stems[name]) throw new Error(`the model returned no ${name}`)
  }
  return stems
}

async function splitNow(
  buffer: AudioBuffer,
  onProgress: (ratio: number) => void
): Promise<{ stems: Record<StemName, StemAudio>; backend: StemBackend }> {
  const [left, right] = await atModelRate(buffer)
  gpuOffered ??= hasWebGpu()
  const order = backendOrder(await gpuOffered, memory)
  const started = performance.now()

  const { result, backend } = await runWithFallback(
    order,
    memory,
    async (on) => {
      try {
        return await splitInWorker(on, left, right, onProgress)
      } catch (err) {
        reset(err instanceof Error ? err : new Error(String(err)))
        throw err
      }
    },
    (failed, err) => {
      const why = err instanceof Error ? err.message : String(err)
      console.warn(`[stems] ${failed} failed, falling back to WASM: ${why}`)
      onProgress(0)
    }
  )

  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  console.info(`[stems] split on ${backend} in ${seconds} s`)
  onProgress(1)
  return { stems: result, backend }
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * Split `buffer` into drums, bass, other and vocals.
 *
 * `onProgress` is called as the work goes, 0-1. Splits run one at a time.
 */
export function splitIntoStems(
  buffer: AudioBuffer,
  onProgress: (ratio: number) => void
): Promise<{ stems: Record<StemName, StemAudio>; backend: StemBackend }> {
  const run = queue.then(() =>
    splitNow(buffer, (ratio) => onProgress(Math.min(1, Math.max(0, ratio))))
  )
  queue = run.catch(() => {})
  return run
}
