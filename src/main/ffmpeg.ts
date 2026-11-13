/**
 * The one ffmpeg every part of the main process spawns: stem saving, MP3
 * export and the decode fallback. Resolved once, at first use.
 */
import { existsSync, readdirSync } from 'node:fs'
import { ffmpegInstallHint, resolveFfmpeg } from '@shared/ffmpegPath'

let resolved: string | null = null

/** The ffmpeg binary to spawn on this machine. */
export function ffmpegBin(): string {
  resolved ??= resolveFfmpeg(process.platform, process.env, existsSync, (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  })
  return resolved
}

/** How to install ffmpeg on this platform, for error messages. */
export const FFMPEG_INSTALL_HINT = ffmpegInstallHint(process.platform)