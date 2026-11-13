/**
 * Which ffmpeg gets spawned. macOS must keep running bare `ffmpeg` off PATH;
 * Windows also looks where winget, scoop and the usual zips put it.
 */
import {
  FFMPEG_DEFAULT,
  ffmpegInstallHint,
  resolveFfmpeg,
  windowsFfmpegCandidates
} from './.build/ffmpegPath.mjs'

const { eq, ok } = globalThis.__t

const none = () => false
const only = (path) => (p) => p.toLowerCase() === path.toLowerCase()

// macOS and Linux: unchanged, bare name, never looks at the disk.
let asked = 0
const counting = () => (asked++, true)
eq('mac: bare ffmpeg', resolveFfmpeg('darwin', { PATH: '/usr/bin' }, counting), 'ffmpeg')
eq('mac: never probes the disk', asked, 0)
eq('linux: bare ffmpeg', resolveFfmpeg('linux', {}, none), FFMPEG_DEFAULT)

// The override wins everywhere, trimmed.
eq('mac: override', resolveFfmpeg('darwin', { DJDAW_FFMPEG: ' /opt/ff/ffmpeg ' }, none), '/opt/ff/ffmpeg')
eq('win: override', resolveFfmpeg('win32', { DJDAW_FFMPEG: 'D:\\ff\\ffmpeg.exe' }, none), 'D:\\ff\\ffmpeg.exe')
eq('blank override ignored', resolveFfmpeg('darwin', { DJDAW_FFMPEG: '  ' }, none), 'ffmpeg')

// Windows, on PATH: bare name, so spawn finds it the normal way.
const winEnv = {
  Path: 'C:\\Windows\\system32;"C:\\Tools\\ff\\bin";',
  LOCALAPPDATA: 'C:\\Users\\k\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\k'
}
eq('win: on PATH (quoted dir, case-insensitive Path)', resolveFfmpeg('win32', winEnv, only('C:\\Tools\\ff\\bin\\ffmpeg.exe')), 'ffmpeg')

// Windows, not on PATH: the winget link is found.
const winget = 'C:\\Users\\k\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe'
eq('win: winget link', resolveFfmpeg('win32', winEnv, only(winget)), winget)
eq('win: Program Files', resolveFfmpeg('win32', { ...winEnv, ProgramFiles: 'C:\\Program Files' }, only('C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe')), 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe')
eq('win: nowhere falls back to bare name', resolveFfmpeg('win32', winEnv, none), 'ffmpeg')

const cands = windowsFfmpegCandidates(winEnv)
eq('win: winget link tried first', cands[0], winget)
ok('win: scoop shim tried', cands.includes('C:\\Users\\k\\scoop\\shims\\ffmpeg.exe'))
ok('win: no doubled separators', cands.every((c) => !c.includes('\\\\')))

ok('hint: brew on mac', ffmpegInstallHint('darwin').includes('brew'))
ok('hint: winget on windows', ffmpegInstallHint('win32').includes('winget'))