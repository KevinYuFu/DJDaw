/**
 * Stem separation, off the UI thread.
 *
 * Runs the model on the backend each request names, keeping the model and its
 * session between requests. Choosing the backend, and falling back when one
 * fails, is `stemSplit.ts`'s job.
 */
import { DemucsProcessor } from 'demucs-web'
import * as ort from 'onnxruntime-web/webgpu'
import { STEM_NAMES, type StemName } from '@shared/stems'
import type { StemBackend } from './stemBackend'

export interface StemSplitRequest {
  type: 'split'
  id: number
  backend: StemBackend
  /** The track at the model's rate, one array per channel, transferred. */
  left: Float32Array
  right: Float32Array
  /** Absolute URL of the folder holding ONNX Runtime's wasm files. */
  wasmPaths: string
  /** The model file, sent with the first request only. */
  model?: ArrayBuffer
}

export type StemSplitMessage =
  | { type: 'progress'; id: number; ratio: number }
  | {
      type: 'done'
      id: number
      stems: Record<StemName, { left: Float32Array; right: Float32Array }>
    }
  | { type: 'error'; id: number; message: string }

// The renderer tsconfig loads both the DOM and WebWorker libs, so `self` is
// typed as a Window here. Narrowed once.
const ctx = self as unknown as DedicatedWorkerGlobalScope

let model: ArrayBuffer | null = null
let loaded: { processor: DemucsProcessor; backend: StemBackend } | null = null

/** A processor whose session runs on `backend`, made if need be. */
async function processorOn(backend: StemBackend): Promise<DemucsProcessor> {
  if (loaded?.backend === backend) return loaded.processor
  if (loaded) {
    await loaded.processor.session?.release()
    loaded = null
  }
  if (!model) throw new Error('the stem model was not loaded')
  const made = new DemucsProcessor({
    ort,
    sessionOptions: {
      executionProviders: [backend],
      graphOptimizationLevel: 'basic'
    }
  })
  await made.loadModel(model)
  loaded = { processor: made, backend }
  return made
}

async function split(req: StemSplitRequest): Promise<void> {
  const { id } = req
  if (req.model) model = req.model
  ort.env.wasm.wasmPaths = req.wasmPaths

  const demucs = await processorOn(req.backend)
  demucs.onProgress = ({ progress }: { progress: number }): void => {
    ctx.postMessage({
      type: 'progress',
      id,
      ratio: Math.min(1, Math.max(0, progress))
    } satisfies StemSplitMessage)
  }
  const result = await demucs.separate(req.left, req.right)

  const stems = {} as Record<StemName, { left: Float32Array; right: Float32Array }>
  const transfer: ArrayBuffer[] = []
  for (const name of STEM_NAMES) {
    const part = result[name]
    if (!part) throw new Error(`the model returned no ${name}`)
    stems[name] = { left: part.left, right: part.right }
    transfer.push(part.left.buffer as ArrayBuffer, part.right.buffer as ArrayBuffer)
  }
  ctx.postMessage({ type: 'done', id, stems } satisfies StemSplitMessage, transfer)
}

// One split at a time: they share the session.
let queue: Promise<void> = Promise.resolve()

ctx.onmessage = (event: MessageEvent<StemSplitRequest>): void => {
  const req = event.data
  if (req.type !== 'split') return
  queue = queue.then(() =>
    split(req).catch((err) => {
      const message = err instanceof Error ? err.message : `ONNX Runtime error ${String(err)}`
      ctx.postMessage({ type: 'error', id: req.id, message } satisfies StemSplitMessage)
    })
  )
}
