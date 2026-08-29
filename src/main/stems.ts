/**
 * Splitting a track into stems.
 *
 * Runs the separation model over the file a segment at a time and writes each
 * stem out as FLAC beside the waveform caches. A stem file is written once and
 * kept: splitting a four minute track takes about a minute and a half, and the
 * result never changes.
 */
import { spawn } from 'node:child_process'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { InferenceSession } from 'onnxruntime-node'
import {
  STEM_NAMES,
  STEM_OVERLAP_FRAMES,
  STEM_SAMPLE_RATE,
  STEM_SEGMENT_FRAMES,
  segmentStarts,
  segmentWindow,
  type StemName
} from '@shared/stems'
import { transcodeArgs } from '@shared/ffmpegArgs'

const FFMPEG_BIN = 'ffmpeg'
const CHANNELS = 2
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Where the model file sits, packaged beside the app. */
function modelPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'htdemucs.onnx')
    : join(app.getAppPath(), 'resources', 'htdemucs.onnx')
}

function stemDir(audioKey: string): string | null {
  return SAFE_ID.test(audioKey) ? join(app.getPath('userData'), 'stems', audioKey) : null
}

/** The four stem files for a track, if every one of them is already written. */
export async function cachedStems(audioKey: string): Promise<Record<StemName, string> | null> {
  const dir = stemDir(audioKey)
  if (!dir) return null
  const paths = {} as Record<StemName, string>
  for (const name of STEM_NAMES) {
    const path = join(dir, `${name}.flac`)
    try {
      const info = await stat(path)
      if (info.size === 0) return null
    } catch {
      return null
    }
    paths[name] = path
  }
  return paths
}

/** Decode `path` to interleaved 44.1 kHz stereo float, which is what the model reads. */
function decodeForModel(path: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const args = transcodeArgs(path, true).slice(0, -5)
    args.push('-ac', String(CHANNELS), '-ar', String(STEM_SAMPLE_RATE), '-f', 'f32le', '-')
    const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-2000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg could not read "${path}" (exit ${code}): ${stderr.trim()}`))
        return
      }
      const buf = Buffer.concat(chunks)
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)))
    })
  })
}

/** Write one stem out as FLAC. */
function encodeFlac(channels: Float32Array[], to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const frames = channels[0].length
    const inter = Buffer.allocUnsafe(frames * CHANNELS * 4)
    let at = 0
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < CHANNELS; c++) {
        inter.writeFloatLE(channels[c][i], at)
        at += 4
      }
    }
    const child = spawn(
      FFMPEG_BIN,
      ['-v', 'error', '-f', 'f32le', '-ar', String(STEM_SAMPLE_RATE), '-ac', String(CHANNELS),
        '-i', 'pipe:0', '-c:a', 'flac', '-compression_level', '5', '-y', to],
      { stdio: ['pipe', 'ignore', 'pipe'] }
    )
    let stderr = ''
    child.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-2000)
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg could not write "${to}": ${stderr.trim()}`))
    )
    child.stdin.on('error', () => {})
    child.stdin.end(inter)
  })
}

let session: InferenceSession | null = null

/** The model, loaded once and kept. Loading it takes a couple of seconds. */
async function model(): Promise<InferenceSession> {
  if (session) return session
  const ort = await import('onnxruntime-node')
  session = await ort.InferenceSession.create(modelPath(), {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all'
  })
  return session
}

/**
 * Split `path` into four stems, writing each as FLAC and handing back where
 * they went. A track already split is returned straight from the cache.
 *
 * `onProgress` is called as each segment finishes, 0-1.
 */
export async function separateStems(
  audioKey: string,
  path: string,
  onProgress: (ratio: number) => void
): Promise<Record<StemName, string>> {
  const already = await cachedStems(audioKey)
  if (already) {
    onProgress(1)
    return already
  }
  const dir = stemDir(audioKey)
  if (!dir) throw new Error(`"${audioKey}" cannot name a folder`)

  const inter = await decodeForModel(path)
  const frames = Math.floor(inter.length / CHANNELS)
  if (frames === 0) throw new Error(`"${path}" decoded to nothing`)

  const mix: Float32Array[] = [new Float32Array(frames), new Float32Array(frames)]
  for (let i = 0; i < frames; i++) {
    mix[0][i] = inter[i * CHANNELS]
    mix[1][i] = inter[i * CHANNELS + 1]
  }

  const ort = await import('onnxruntime-node')
  const sess = await model()
  const N = STEM_SEGMENT_FRAMES
  const window = segmentWindow(N, STEM_OVERLAP_FRAMES)
  const starts = segmentStarts(frames, N, STEM_OVERLAP_FRAMES)
  const out = STEM_NAMES.map(() => [new Float32Array(frames), new Float32Array(frames)])
  const weight = new Float32Array(frames)
  const segment = new Float32Array(CHANNELS * N)

  for (let s = 0; s < starts.length; s++) {
    const start = starts[s]
    const end = Math.min(start + N, frames)
    segment.fill(0)
    for (let c = 0; c < CHANNELS; c++) {
      for (let i = start; i < end; i++) segment[c * N + (i - start)] = mix[c][i]
    }
    const result = await sess.run({ mix: new ort.Tensor('float32', segment, [1, CHANNELS, N]) })
    const stems = result.stems.data as Float32Array
    const len = end - start
    for (let k = 0; k < STEM_NAMES.length; k++) {
      for (let c = 0; c < CHANNELS; c++) {
        const base = (k * CHANNELS + c) * N
        const into = out[k][c]
        for (let i = 0; i < len; i++) into[start + i] += stems[base + i] * window[i]
      }
    }
    for (let i = 0; i < len; i++) weight[start + i] += window[i]
    onProgress((s + 1) / starts.length)
  }

  for (let k = 0; k < STEM_NAMES.length; k++) {
    for (let c = 0; c < CHANNELS; c++) {
      const a = out[k][c]
      for (let i = 0; i < frames; i++) a[i] /= Math.max(weight[i], 1e-8)
    }
  }

  // Written to one side and moved into place, so a split stopped half way
  // never leaves a folder that looks finished.
  const pending = `${dir}.part`
  await rm(pending, { recursive: true, force: true })
  await mkdir(pending, { recursive: true })
  for (let k = 0; k < STEM_NAMES.length; k++) {
    await encodeFlac(out[k], join(pending, `${STEM_NAMES[k]}.flac`))
  }
  await rm(dir, { recursive: true, force: true })
  await mkdir(join(dir, '..'), { recursive: true })
  await rename(pending, dir)

  const written = await cachedStems(audioKey)
  if (!written) throw new Error(`stems for "${audioKey}" did not survive being written`)
  return written
}
