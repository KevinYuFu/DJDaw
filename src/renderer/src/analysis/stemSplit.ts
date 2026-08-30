/**
 * Splitting a track into stems.
 *
 * The separation runs here rather than in the main process: the model is an
 * ONNX graph that ONNX Runtime executes on the GPU through WebGPU, and both
 * live in the renderer. Nothing leaves the machine — the model file ships with
 * the app and is read off disk.
 *
 * The model reads a segment of audio at a time along with its spectrogram, and
 * returns one waveform and one set of spectrogram masks per stem. Turning
 * audio into a spectrogram and back is `demucs-web`, which carries the exact
 * conventions the model was trained with.
 */
import { DemucsProcessor } from 'demucs-web'
import * as ort from 'onnxruntime-web/webgpu'
import { STEM_NAMES, STEM_SAMPLE_RATE, type StemName } from '@shared/stems'

/** One stem's audio, at {@link STEM_SAMPLE_RATE}. */
export interface StemAudio {
  left: Float32Array
  right: Float32Array
}

/** Where the runtime ran, which is the difference between seconds and minutes. */
export type StemBackend = 'webgpu' | 'wasm'

let ready: Promise<{ processor: DemucsProcessor; backend: StemBackend }> | null = null

/**
 * The model, loaded once and kept.
 *
 * WebGPU where it is offered and WASM where it is not. The two differ by more
 * than a factor of ten, so which one ran is worth knowing.
 */
async function processor(): Promise<{ processor: DemucsProcessor; backend: StemBackend }> {
  if (ready) return ready
  ready = (async () => {
    // Served out of the renderer's public folder by `scripts/prepare-ort.mjs`.
    // Absolute, because the runtime imports these as modules by name.
    ort.env.wasm.wasmPaths = new URL('ort/', window.location.href).href
    const bytes = await window.api.readStemModel()
    const backend: StemBackend = (await hasWebGpu()) ? 'webgpu' : 'wasm'
    const made = new DemucsProcessor({
      ort,
      sessionOptions: {
        executionProviders: [backend],
        graphOptimizationLevel: 'basic'
      }
    })
    await made.loadModel(bytes)
    return { processor: made, backend }
  })()
  try {
    return await ready
  } catch (err) {
    // A failed load must not poison every later attempt.
    ready = null
    throw err
  }
}

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

/**
 * The track resampled to the rate the model works at, split into channels.
 *
 * A mono file is played into both channels, which is what the model expects.
 */
async function atModelRate(buffer: AudioBuffer): Promise<[Float32Array, Float32Array]> {
  const frames = Math.max(1, Math.round((buffer.duration * STEM_SAMPLE_RATE) / 1))
  const ctx = new OfflineAudioContext(2, frames, STEM_SAMPLE_RATE)
  const node = ctx.createBufferSource()
  node.buffer = buffer
  node.connect(ctx.destination)
  node.start()
  const at = await ctx.startRendering()
  return [at.getChannelData(0), at.getChannelData(1)]
}

/**
 * Split `buffer` into drums, bass, other and vocals.
 *
 * `onProgress` is called as the work goes, 0-1.
 */
export async function splitIntoStems(
  buffer: AudioBuffer,
  onProgress: (ratio: number) => void
): Promise<{ stems: Record<StemName, StemAudio>; backend: StemBackend }> {
  const { processor: demucs, backend } = await processor()
  demucs.onProgress = ({ progress }: { progress: number }): void => {
    onProgress(Math.min(1, Math.max(0, progress)))
  }
  const [left, right] = await atModelRate(buffer)
  const result = await demucs.separate(left, right)
  const stems = {} as Record<StemName, StemAudio>
  for (const name of STEM_NAMES) {
    const part = result[name]
    if (!part) throw new Error(`the model returned no ${name}`)
    stems[name] = { left: part.left, right: part.right }
  }
  onProgress(1)
  return { stems, backend }
}
