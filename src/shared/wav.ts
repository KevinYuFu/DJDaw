/**
 * WAV encoding, for writing a finished edit out as a file.
 *
 * Deliberately dependency-free and DOM-free: the renderer produces the audio,
 * but the bytes may well be written from the main process, and the tests run
 * under plain Node.
 *
 * Only the canonical 44-byte header is written — `RIFF`, `WAVE`, a 16-byte
 * `fmt ` chunk, then `data`. Nothing we care about (ffmpeg, Chromium, Logic,
 * rekordbox) needs more than that, and every extra chunk is one more thing to
 * get wrong.
 */

/** Bit depths we write. 16 and 24 are integer PCM; 32 is float. */
export type BitDepth = 16 | 24 | 32

/**
 * `fmt ` chunk `audioFormat` codes.
 *
 * This is the field that decides how a reader interprets the sample bytes, and
 * declaring the wrong one produces a file that either opens as noise or does
 * not open at all. Integer depths are 1 (WAVE_FORMAT_PCM), 32-bit is 3
 * (WAVE_FORMAT_IEEE_FLOAT) — the sample size alone does not say which.
 */
export const WAVE_FORMAT_PCM = 1
export const WAVE_FORMAT_IEEE_FLOAT = 3

/** Bytes in the canonical header: 12 RIFF + 24 `fmt ` + 8 `data`. */
export const WAV_HEADER_BYTES = 44

/** Largest magnitude an integer sample of this depth can hold, per sign. */
const INT_MAX = { 16: 32767, 24: 8388607 } as const
const INT_MIN = { 16: 32768, 24: 8388608 } as const

/**
 * Fold a sample into [-1, 1].
 *
 * Everything is clamped before it is written, at every depth. A sample above
 * full scale has nowhere to go in an integer word: scaling it and letting it
 * overflow wraps a loud peak round to full-scale negative, which is not a
 * distorted peak but a bang. Float files could carry the overshoot, but an
 * export is a finished track and whatever plays it would clip anyway, so it
 * clips here where the behaviour is predictable.
 *
 * NaN becomes silence rather than whatever the cast happens to produce.
 */
function clampSample(v: number): number {
  if (Number.isNaN(v)) return 0
  return v < -1 ? -1 : v > 1 ? 1 : v
}

/**
 * Quantise to a signed integer of `depth` bits.
 *
 * Positive and negative use different scales because two's complement is not
 * symmetric: +1.0 has to land on 32767, not on 32768, which does not fit.
 */
function toInt(v: number, depth: 16 | 24): number {
  const s = clampSample(v)
  return Math.round(s < 0 ? s * INT_MIN[depth] : s * INT_MAX[depth])
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/**
 * Encode interleaved little-endian WAV bytes.
 *
 * @param channels One Float32Array per channel: one for mono, two for stereo,
 *   more if you have them. Channels shorter than the longest are padded with
 *   silence, so a ragged set of buffers cannot desynchronise the interleave.
 * @param sampleRate Frames per second.
 * @param bitDepth 16 or 24 for integer PCM, 32 for float.
 * @returns The complete file, header included.
 */
export function encodeWav(
  channels: readonly Float32Array[],
  sampleRate: number,
  bitDepth: BitDepth
): ArrayBuffer {
  const channelCount = channels.length
  if (channelCount === 0) {
    throw new RangeError('encodeWav: need at least one channel')
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`encodeWav: bad sample rate ${sampleRate}`)
  }
  if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) {
    throw new RangeError(`encodeWav: unsupported bit depth ${bitDepth}`)
  }

  let frames = 0
  for (const channel of channels) {
    if (channel.length > frames) frames = channel.length
  }

  const bytesPerSample = bitDepth / 8
  const blockAlign = channelCount * bytesPerSample
  const dataBytes = frames * blockAlign
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  // Everything after this field, which is the file length less 'RIFF' and the
  // field itself. A reader that trusts it and finds it wrong stops early.
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')

  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, bitDepth === 32 ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)

  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = WAV_HEADER_BYTES
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const channel = channels[c]
      const sample = i < channel.length ? channel[i] : 0
      if (bitDepth === 32) {
        view.setFloat32(offset, clampSample(sample), true)
      } else if (bitDepth === 16) {
        view.setInt16(offset, toInt(sample, 16), true)
      } else {
        // No setInt24, so the three bytes go out by hand, low byte first.
        const value = toInt(sample, 24)
        view.setUint8(offset, value & 0xff)
        view.setUint8(offset + 1, (value >> 8) & 0xff)
        view.setUint8(offset + 2, (value >> 16) & 0xff)
      }
      offset += bytesPerSample
    }
  }

  return buffer
}
