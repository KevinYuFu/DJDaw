/**
 * Where a track's stems are kept.
 *
 * The separation itself runs in the renderer, on the GPU. This side hands over
 * the model file and keeps the results: four FLACs beside the waveform caches,
 * written once. Splitting a track takes long enough that it is worth never
 * doing twice, and the result never changes.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { STEM_NAMES, STEM_SAMPLE_RATE, type StemName } from '@shared/stems'

const FFMPEG_BIN = 'ffmpeg'
const CHANNELS = 2
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Where the model file sits, packaged beside the app. */
function modelPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'htdemucs_embedded.onnx')
    : join(app.getAppPath(), 'resources', 'htdemucs_embedded.onnx')
}

/** The model, for the renderer to hand to ONNX Runtime. */
export async function readStemModel(): Promise<ArrayBuffer> {
  const buf = await readFile(modelPath())
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
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
      if ((await stat(path)).size === 0) return null
    } catch {
      return null
    }
    paths[name] = path
  }
  return paths
}

/** Write one stem out as FLAC: lossless, and less than half the size of WAV. */
function encodeFlac(interleaved: Float32Array, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
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
    child.stdin.end(Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength))
  })
}

/**
 * Keep a track's stems, and hand back where they went.
 *
 * Written to one side and moved into place, so a split that stops half way
 * never leaves a folder that looks finished.
 */
export async function writeStems(
  audioKey: string,
  stems: Record<StemName, Float32Array>
): Promise<Record<StemName, string>> {
  const dir = stemDir(audioKey)
  if (!dir) throw new Error(`"${audioKey}" cannot name a folder`)
  const pending = `${dir}.part`
  await rm(pending, { recursive: true, force: true })
  await mkdir(pending, { recursive: true })
  for (const name of STEM_NAMES) {
    await encodeFlac(stems[name], join(pending, `${name}.flac`))
  }
  await rm(dir, { recursive: true, force: true })
  await mkdir(join(dir, '..'), { recursive: true })
  await rename(pending, dir)
  const written = await cachedStems(audioKey)
  if (!written) throw new Error(`stems for "${audioKey}" did not survive being written`)
  return written
}
