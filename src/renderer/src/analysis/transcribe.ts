/**
 * Hearing what a vocal says.
 *
 * A speech model, run on a vocal that has already been separated from the
 * music. Separating first is what makes this workable: the same model on a
 * full mix mishears far more, because it was never trained on drums.
 *
 * It still gets things wrong, and always will — singing is not speech. What it
 * is good enough for is finding candidates, which is why nothing it reports is
 * acted on without leaving a way back.
 */
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import type { HeardWord } from '@shared/censor'

/** Frames per second the model listens at. Audio is resampled to this. */
const MODEL_RATE = 16000

/** How much audio it takes in at once, and how far each pass reaches back. */
const CHUNK_SEC = 30
const STRIDE_SEC = 5

const MODEL = 'whisper-base_timestamped'

let ready: Promise<AutomaticSpeechRecognitionPipeline> | null = null

/** The model, loaded once and kept. Read off disk; nothing is fetched. */
function transcriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (ready) return ready
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = new URL('models/', window.location.href).href
  // Its own runtime, at its own version, served rather than fetched from a CDN.
  const wasm = env.backends.onnx.wasm
  if (wasm) wasm.wasmPaths = new URL('ort-transformers/', window.location.href).href
  ready = pipeline('automatic-speech-recognition', MODEL, { dtype: 'fp32' }).catch(
    (err: unknown) => {
      // A failed load must not poison every later attempt.
      ready = null
      throw err
    }
  )
  return ready
}

/** The vocal as one channel at the rate the model listens at. */
async function atModelRate(left: Float32Array, right: Float32Array, from: number): Promise<Float32Array> {
  const frames = Math.max(1, Math.round((left.length / from) * MODEL_RATE))
  const ctx = new OfflineAudioContext(1, frames, MODEL_RATE)
  const buffer = ctx.createBuffer(2, left.length, from)
  buffer.getChannelData(0).set(left)
  buffer.getChannelData(1).set(right)
  const node = ctx.createBufferSource()
  node.buffer = buffer
  node.connect(ctx.destination)
  node.start()
  return (await ctx.startRendering()).getChannelData(0)
}

/**
 * Every word the vocal was heard to say, with when it was said.
 *
 * Words the model could not place in time are dropped: a word without a time
 * is nothing a censor can act on.
 */
export async function heardWords(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number
): Promise<HeardWord[]> {
  const asr = await transcriber()
  const audio = await atModelRate(left, right, sampleRate)
  const out = await asr(audio, {
    return_timestamps: 'word',
    chunk_length_s: CHUNK_SEC,
    stride_length_s: STRIDE_SEC,
    language: 'en',
    task: 'transcribe'
  })
  const chunks = Array.isArray(out) ? out[0]?.chunks : out?.chunks
  const words: HeardWord[] = []
  for (const chunk of chunks ?? []) {
    const [from, to] = chunk.timestamp ?? []
    if (typeof from !== 'number' || typeof to !== 'number') continue
    const text = String(chunk.text ?? '').trim()
    if (text) words.push({ text, from, to })
  }
  return words
}
