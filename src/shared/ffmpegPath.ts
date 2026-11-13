/**
 * Which ffmpeg binary to run.
 *
 * On macOS this is bare `ffmpeg`, found on PATH, exactly as before. Windows
 * apps started from the Start menu often see a PATH from before ffmpeg was
 * installed, so there the usual install folders are tried as well.
 *
 * `DJDAW_FFMPEG`, if set, wins everywhere: a full path to the binary to use.
 *
 * Pure, so it can be tested without touching the disk: the caller passes in
 * the platform, the environment and a way to ask whether a file exists.
 */

/** The bare name, left for the OS to find on PATH. */
export const FFMPEG_DEFAULT = 'ffmpeg'

/** Environment variable that names the ffmpeg binary outright. */
export const FFMPEG_ENV = 'DJDAW_FFMPEG'

type Env = Record<string, string | undefined>

/** Windows environment names are case-insensitive; Node's object is not always. */
function envGet(env: Env, name: string): string | undefined {
  if (env[name] !== undefined) return env[name]
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

function winJoin(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('\\')
}

/** Folders ffmpeg usually lands in on Windows, most likely first. */
export function windowsFfmpegCandidates(env: Env): string[] {
  const out: string[] = []
  const localAppData = envGet(env, 'LOCALAPPDATA')
  const userProfile = envGet(env, 'USERPROFILE')
  const programFiles = envGet(env, 'ProgramFiles') ?? 'C:\\Program Files'
  const programData = envGet(env, 'ProgramData') ?? 'C:\\ProgramData'
  // winget (Gyan.FFmpeg and friends) links its binaries here.
  if (localAppData) out.push(winJoin(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'))
  if (userProfile) out.push(winJoin(userProfile, 'scoop', 'shims', 'ffmpeg.exe'))
  out.push(winJoin(programData, 'chocolatey', 'bin', 'ffmpeg.exe'))
  out.push(winJoin(programFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'))
  out.push('C:\\ffmpeg\\bin\\ffmpeg.exe')
  return out
}

/** Every directory on a Windows PATH, with ffmpeg.exe appended. */
function windowsPathCandidates(env: Env): string[] {
  const path = envGet(env, 'PATH') ?? ''
  return path
    .split(';')
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter((d) => d.length > 0)
    .map((d) => winJoin(d, 'ffmpeg.exe'))
}

/**
 * The ffmpeg to spawn.
 *
 * - `DJDAW_FFMPEG` set: that, as given.
 * - Not Windows: bare `ffmpeg`, for the OS to find on PATH.
 * - Windows: bare `ffmpeg` if it is on PATH, else the first usual install
 *   folder that has it, else bare `ffmpeg` so the error still says "not found".
 */
export function resolveFfmpeg(
  platform: string,
  env: Env,
  exists: (path: string) => boolean
): string {
  const override = envGet(env, FFMPEG_ENV)?.trim()
  if (override) return override
  if (platform !== 'win32') return FFMPEG_DEFAULT
  if (windowsPathCandidates(env).some(exists)) return FFMPEG_DEFAULT
  return windowsFfmpegCandidates(env).find(exists) ?? FFMPEG_DEFAULT
}

/** How to install ffmpeg, said the way each platform's users would. */
export function ffmpegInstallHint(platform: string): string {
  return platform === 'win32' ? '`winget install Gyan.FFmpeg`' : '`brew install ffmpeg`'
}