/**
 * Key detection, off the main thread.
 *
 * The analysis is Essentia's `KeyExtractor`, which builds a pitch class
 * profile of the track and matches it against a set of key profiles. The
 * profile set is `braw`, drawn from a study of dance music rather than of
 * classical listening tests: measured over this collection against
 * rekordbox's own answer it names three quarters of keys exactly, where the
 * classical profiles name barely half.
 *
 * Essentia answers with a note and a mode; `shared/musicalKey` turns that into
 * the names the app shows.
 */

import { EssentiaWASM } from 'essentia.js/dist/essentia-wasm.es.js'
import Essentia from 'essentia.js/dist/essentia.js-core.es.js'
import {
  camelotFor,
  classicFor,
  pitchClassOfName,
  type DetectedKey,
  type KeyMode
} from '@shared/musicalKey'

export interface KeyRequest {
  channels: Float32Array[]
  sampleRate: number
}

export type KeyWorkerMessage =
  | { type: 'done'; result: DetectedKey | null }
  | { type: 'error'; message: string }

/**
 * Frame and hop, in samples.
 *
 * Equal, so frames do not overlap. Halving the hop gains two points of
 * accuracy over this collection and costs twice the time, which is not a
 * trade worth making while a track is being loaded.
 */
const FRAME = 4096
const HOP = 4096

/** Key profile set. See the note at the top of the file. */
const PROFILE = 'braw'

/** One channel out of many, averaged. Key does not live in the stereo image. */
function downmix(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const n = channels[0].length
  const out = new Float32Array(n)
  for (const channel of channels) {
    for (let i = 0; i < n; i++) out[i] += channel[i]
  }
  for (let i = 0; i < n; i++) out[i] /= channels.length
  return out
}

/** The parts of Essentia this file uses. The package ships no types. */
interface KeyAnalyser {
  arrayToVector(samples: Float32Array): { delete?(): void }
  KeyExtractor(...args: unknown[]): { key?: string; scale?: string; strength?: number }
}

// Built once: the WASM module costs more to start than an analysis does to run.
let essentia: KeyAnalyser | undefined

function analyser(): KeyAnalyser {
  essentia ??= new Essentia(EssentiaWASM) as KeyAnalyser
  return essentia
}

/** The key of one mono signal, or null when there is nothing to hear. */
export function detectKeyOf(mono: Float32Array, sampleRate: number): DetectedKey | null {
  if (mono.length < FRAME || !(sampleRate > 0)) return null

  const e = analyser()
  const vector = e.arrayToVector(mono)
  try {
    const answer = e.KeyExtractor(
      vector,
      // Average out any tuning the track is not at, so a track recorded a
      // little sharp is not read as the key above.
      true,
      FRAME,
      HOP,
      12,
      3500,
      60,
      25,
      0.2,
      PROFILE,
      sampleRate,
      0.0001,
      440,
      'cosine',
      'hann'
    )

    const pitchClass = pitchClassOfName(answer.key ?? '')
    if (pitchClass < 0) return null
    const mode: KeyMode = answer.scale === 'minor' ? 'minor' : 'major'
    return {
      camelot: camelotFor(pitchClass, mode),
      classic: classicFor(pitchClass, mode),
      pitchClass,
      mode,
      confidence: Math.max(0, Math.min(1, answer.strength ?? 0))
    }
  } finally {
    vector.delete?.()
  }
}

// The renderer tsconfig loads both the DOM and WebWorker libs, so `self` is
// typed as a Window here. Narrowed once.
const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<KeyRequest>): void => {
  try {
    const { channels, sampleRate } = event.data
    ctx.postMessage({
      type: 'done',
      result: detectKeyOf(downmix(channels), sampleRate)
    } satisfies KeyWorkerMessage)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.postMessage({ type: 'error', message } satisfies KeyWorkerMessage)
  }
}
