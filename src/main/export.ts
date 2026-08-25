/**
 * Writing a rendered edit to disk.
 *
 * The audio work happens in the renderer: it renders the timeline through the
 * same worklet it played, then hands finished WAV bytes over IPC. All this
 * file decides is where the file goes, what it is called, and — for MP3 —
 * pipes the WAV through ffmpeg on the way.
 *
 * Exports land in one dedicated folder, `~/Music/DJDaw`.
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { app } from 'electron'
import type { ExportFormat, ExportRequest, ExportResult } from '@shared/types'

/** The one folder every export goes into, inside the user's Music directory. */
const EXPORT_FOLDER = 'DJDaw'

/**
 * The same binary the decode fallback in `ipc.ts` uses. Neither looks it up:
 * it only has to be on PATH, and WAV export deliberately never needs it.
 */
const FFMPEG_BIN = 'ffmpeg'

/** ffmpeg can be chatty; only the tail is worth putting in an error message. */
const MAX_FFMPEG_STDERR = 4096

/** 320 kbps CBR: the format DJ software and CDJs are happiest with. */
const MP3_BITRATE = '320k'

/**
 * Longest name a file is built from. Well under the 255-byte limit these
 * filesystems impose, which leaves room for a " 2" suffix and the extension.
 */
const MAX_NAME_LENGTH = 96

/** Used when the requested name sanitises away to nothing at all. */
const FALLBACK_NAME = 'Export'

/** Suffixes tried before giving up, so a stuck folder cannot loop forever. */
const MAX_NAME_ATTEMPTS = 1000

/**
 * Turn a requested name into something safe to use as a file name.
 *
 * Names arrive from a track title or from typing. Path separators would let a
 * name climb out of the export folder and a leading dot hides the file; the
 * rest — control characters and punctuation macOS and Windows dislike — is
 * about the file still opening afterwards.
 */
export function safeFileName(name: string): string {
  let cleaned = typeof name === 'string' ? name : ''

  // Separators go first and become spaces rather than being deleted, so two
  // halves of a stripped path cannot run together into a new word.
  cleaned = cleaned.replace(/[/\\]/g, ' ')
  cleaned = cleaned.replace(/[\u0000-\u001f\u007f]/g, ' ')
  cleaned = cleaned.replace(/[:*?"<>|]/g, ' ')
  cleaned = cleaned.replace(/\s+/g, ' ').trim()

  // Dots and spaces together, so the '..' left behind by a stripped '../../'
  // goes with them; '.' and '..' on their own fall through to the fallback.
  cleaned = cleaned.replace(/^[.\s]+/, '')
  cleaned = cleaned.slice(0, MAX_NAME_LENGTH)
  // A trailing dot or space is silently dropped by Windows, which would let two
  // different names collide and defeat the never-overwrite check below.
  cleaned = cleaned.replace(/[.\s]+$/, '')

  return cleaned || FALLBACK_NAME
}

/**
 * `~/Music/DJDaw`, created if it is not there yet.
 *
 * `app.getPath('music')` is the real, localised Music folder rather than a
 * literal "Music", so the export lands where the system actually keeps music.
 */
async function ensureExportDir(): Promise<string> {
  let music: string
  try {
    music = app.getPath('music')
  } catch {
    // getPath throws when the OS has no music folder registered. Home is not
    // ideal, but it is somewhere the user can still find the file.
    music = join(homedir(), 'Music')
  }

  const dir = join(music, EXPORT_FOLDER)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Write the bytes under `base`, adding " 2", " 3" and so on until a name is
 * free. Returns the absolute path actually written.
 *
 * The exclusive flag does the checking rather than a prior existence test:
 * testing and then writing still races two exports of the same name against
 * each other, and losing a finished render to a silent overwrite is exactly
 * what we are avoiding.
 */
async function writeWithoutOverwriting(
  dir: string,
  base: string,
  format: ExportFormat,
  data: Buffer
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const name = attempt === 1 ? `${base}.${format}` : `${base} ${attempt}.${format}`
    const path = resolvePath(join(dir, name))

    // Belt and braces over `safeFileName`: whatever it returned, the file has
    // to end up directly inside the export folder and nowhere else.
    if (dirname(path) !== resolvePath(dir)) {
      throw new Error(`Refusing to export outside ${dir}`)
    }

    try {
      await writeFile(path, data, { flag: 'wx' })
      return path
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }

  throw new Error(`Too many files already called "${base}" in ${dir}`)
}

/**
 * WAV bytes in, MP3 bytes out.
 *
 * Piped both ways so no temporary file is involved: the render goes in on
 * stdin and the encoded track comes back on stdout. `-f mp3` is not optional
 * there — a pipe has no extension for ffmpeg to infer the format from.
 */
function encodeMp3(wav: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v',
      'error',
      '-i',
      'pipe:0',
      '-codec:a',
      'libmp3lame',
      '-b:a',
      MP3_BITRATE,
      '-f',
      'mp3',
      'pipe:1'
    ]
    const child = spawn(FFMPEG_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] })

    const chunks: Buffer[] = []
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_FFMPEG_STDERR)
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'ENOENT'
          ? new Error(
              'ffmpeg was not found on PATH, so MP3 export is not available. ' +
                'Install it (for example `brew install ffmpeg`) and restart DJDaw. ' +
                'WAV export works without it.'
            )
          : err
      )
    })

    // ffmpeg closes stdin the instant it gives up on the input, so a write
    // still in flight lands on a broken pipe. That is never the real failure —
    // the exit code and stderr are — so swallow it and let `close` report.
    child.stdin.on('error', () => undefined)

    child.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim()
        const why = detail ? `: ${detail}` : ''
        reject(new Error(`ffmpeg could not encode the MP3 (exit ${code ?? 'signal'})${why}`))
        return
      }
      const out = Buffer.concat(chunks)
      if (out.byteLength === 0) {
        reject(new Error('ffmpeg produced no MP3 data'))
        return
      }
      resolve(out)
    })

    child.stdin.end(wav)
  })
}

/**
 * Write a rendered edit into `~/Music/DJDaw` and report where it landed.
 *
 * Failures come back in `error` instead of as a rejection. Every one of them
 * is something the user can act on — ffmpeg missing, the disk full — so the UI
 * wants a line of text it can show, not an exception to unwrap. Pass the
 * returned `path` to `revealInFinder` to show the file.
 */
export async function exportAudio(request: ExportRequest): Promise<ExportResult> {
  try {
    const format: ExportFormat = request?.format === 'mp3' ? 'mp3' : 'wav'
    const wav = Buffer.from(request?.wav ?? new ArrayBuffer(0))
    if (wav.byteLength === 0) return { path: null, error: 'Nothing to export.' }

    const dir = await ensureExportDir()
    const base = safeFileName(request?.name ?? '')
    // Encode before touching the folder: a failed encode should not leave a
    // half-claimed name behind for the next export to trip over.
    const data = format === 'mp3' ? await encodeMp3(wav) : wav

    return { path: await writeWithoutOverwriting(dir, base, format, data) }
  } catch (err) {
    return { path: null, error: err instanceof Error ? err.message : String(err) }
  }
}
