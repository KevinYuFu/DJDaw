/**
 * WAV encoding.
 *
 * Two things here break a file completely rather than subtly. The declared
 * chunk sizes have to match the bytes that are actually there, or a reader
 * stops early and gets a truncated track. And the `fmt ` audioFormat has to say
 * integer or float correctly, because the sample size alone does not: a float
 * file labelled PCM opens as noise.
 *
 * The third thing is the classic quantising bug — a sample over 1.0 scaled into
 * an integer word overflows and wraps to full-scale negative, so the loudest
 * peak in the track comes out as a bang.
 */
import * as W from './.build/wav.mjs'

const { eq, ok } = globalThis.__t

const ascii = (bytes, at, len) =>
  String.fromCharCode(...new Uint8Array(bytes, at, len))
const u16 = (bytes, at) => new DataView(bytes).getUint16(at, true)
const u32 = (bytes, at) => new DataView(bytes).getUint32(at, true)

/** Read back one interleaved sample, as the integer or float actually stored. */
function raw(bytes, depth, index) {
  const view = new DataView(bytes)
  const at = W.WAV_HEADER_BYTES + index * (depth / 8)
  if (depth === 32) return view.getFloat32(at, true)
  if (depth === 16) return view.getInt16(at, true)
  const v = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16)
  return v >= 0x800000 ? v - 0x1000000 : v
}

const mono = (values) => [Float32Array.from(values)]

// ---------------------------------------------------------------------------
// Chunk layout
// ---------------------------------------------------------------------------

{
  const bytes = W.encodeWav(mono([0, 0, 0, 0]), 44100, 16)
  eq('starts with RIFF', ascii(bytes, 0, 4), 'RIFF')
  eq('is a WAVE file', ascii(bytes, 8, 4), 'WAVE')
  eq('then the fmt chunk', ascii(bytes, 12, 4), 'fmt ')
  eq('fmt chunk is 16 bytes', u32(bytes, 16), 16)
  eq('then the data chunk', ascii(bytes, 36, 4), 'data')
  eq('header is 44 bytes', W.WAV_HEADER_BYTES, 44)
}

// ---------------------------------------------------------------------------
// Declared sizes match the real bytes
// ---------------------------------------------------------------------------

for (const depth of [16, 24, 32]) {
  for (const channels of [mono([0.1, 0.2, 0.3]), [
    Float32Array.from([0.1, 0.2, 0.3]),
    Float32Array.from([0.4, 0.5, 0.6])
  ]]) {
    const bytes = W.encodeWav(channels, 48000, depth)
    const label = `${depth}-bit ${channels.length}ch`
    const expected = 44 + 3 * channels.length * (depth / 8)
    eq(`${label}: file is exactly as long as it should be`, bytes.byteLength, expected)
    eq(`${label}: RIFF size covers everything after it`, u32(bytes, 4), bytes.byteLength - 8)
    eq(`${label}: data size is the payload`, u32(bytes, 40), bytes.byteLength - 44)
  }
}

// ---------------------------------------------------------------------------
// fmt fields
// ---------------------------------------------------------------------------

{
  const bytes = W.encodeWav(mono([0]), 44100, 16)
  eq('16-bit is PCM', u16(bytes, 20), W.WAVE_FORMAT_PCM)
  eq('PCM is format 1', W.WAVE_FORMAT_PCM, 1)
  eq('channel count is written', u16(bytes, 22), 1)
  eq('sample rate is written', u32(bytes, 24), 44100)
  eq('byte rate is rate * block align', u32(bytes, 28), 44100 * 2)
  eq('block align is one frame', u16(bytes, 32), 2)
  eq('bit depth is written', u16(bytes, 34), 16)
}

{
  const bytes = W.encodeWav(mono([0]), 44100, 24)
  eq('24-bit is PCM too', u16(bytes, 20), W.WAVE_FORMAT_PCM)
  eq('24-bit block align is 3 bytes', u16(bytes, 32), 3)
  eq('24-bit depth is written', u16(bytes, 34), 24)
}

{
  const bytes = W.encodeWav(mono([0]), 44100, 32)
  eq('32-bit is float, not PCM', u16(bytes, 20), W.WAVE_FORMAT_IEEE_FLOAT)
  eq('float is format 3', W.WAVE_FORMAT_IEEE_FLOAT, 3)
  ok('float is not labelled PCM', W.WAVE_FORMAT_IEEE_FLOAT !== W.WAVE_FORMAT_PCM)
  eq('32-bit depth is written', u16(bytes, 34), 32)
}

{
  const stereo = W.encodeWav(
    [Float32Array.from([0]), Float32Array.from([0])],
    96000,
    24
  )
  eq('stereo says two channels', u16(stereo, 22), 2)
  eq('stereo block align is both channels', u16(stereo, 32), 6)
  eq('stereo byte rate follows', u32(stereo, 28), 96000 * 6)
}

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

{
  // 0.5 sits exactly on no integer boundary, which is the point: it must come
  // back as the same value at every depth, not drift by a quantum.
  const bytes16 = W.encodeWav(mono([0.5]), 44100, 16)
  eq('16-bit 0.5 quantises to half of full scale', raw(bytes16, 16, 0), Math.round(0.5 * 32767))
  eq('16-bit 0.5 comes back as 0.5', raw(bytes16, 16, 0) / 32767, 0.5, 1 / 32767)

  const bytes24 = W.encodeWav(mono([0.5]), 44100, 24)
  eq('24-bit 0.5 comes back as 0.5', raw(bytes24, 24, 0) / 8388607, 0.5, 1 / 8388607)

  const bytes32 = W.encodeWav(mono([0.5]), 44100, 32)
  eq('float keeps 0.5 exactly', raw(bytes32, 32, 0), 0.5)
}

{
  const values = [0, 0.25, -0.25, 0.75, -0.75]
  const bytes = W.encodeWav(mono(values), 44100, 24)
  let worst = 0
  for (let i = 0; i < values.length; i++) {
    const back = raw(bytes, 24, i)
    const decoded = back < 0 ? back / 8388608 : back / 8388607
    worst = Math.max(worst, Math.abs(decoded - values[i]))
  }
  ok('24-bit round trip is within one quantum', worst <= 1 / 8388607)
}

{
  const values = [0, 0.1, -0.1, 0.9, -0.9, 0.333]
  const bytes = W.encodeWav(mono(values), 44100, 32)
  let exact = true
  for (let i = 0; i < values.length; i++) {
    if (raw(bytes, 32, i) !== Math.fround(values[i])) exact = false
  }
  ok('float round trip is exact', exact)
}

// ---------------------------------------------------------------------------
// Clipping. Over full scale must clip, never wrap.
// ---------------------------------------------------------------------------

{
  const bytes = W.encodeWav(mono([1.5, -1.5, 1, -1, 2000]), 44100, 16)
  eq('16-bit clips over 1.0 to full scale positive', raw(bytes, 16, 0), 32767)
  eq('16-bit clips under -1.0 to full scale negative', raw(bytes, 16, 1), -32768)
  eq('16-bit 1.0 is full scale, not an overflow', raw(bytes, 16, 2), 32767)
  eq('16-bit -1.0 is full scale negative', raw(bytes, 16, 3), -32768)
  ok('a wildly hot sample stays positive', raw(bytes, 16, 4) > 0)
}

{
  const bytes = W.encodeWav(mono([1.5, -1.5, 1, -1]), 44100, 24)
  eq('24-bit clips over 1.0', raw(bytes, 24, 0), 8388607)
  eq('24-bit clips under -1.0', raw(bytes, 24, 1), -8388608)
  eq('24-bit 1.0 does not overflow', raw(bytes, 24, 2), 8388607)
  eq('24-bit -1.0 is full scale negative', raw(bytes, 24, 3), -8388608)
}

{
  const bytes = W.encodeWav(mono([1.5, -1.5, 4]), 44100, 32)
  eq('float clips over 1.0 as well', raw(bytes, 32, 0), 1)
  eq('float clips under -1.0 as well', raw(bytes, 32, 1), -1)
  eq('float never leaves full scale', raw(bytes, 32, 2), 1)
}

{
  const bytes = W.encodeWav(mono([NaN]), 44100, 16)
  eq('NaN becomes silence, not a bang', raw(bytes, 16, 0), 0)
}

// ---------------------------------------------------------------------------
// Interleaving
// ---------------------------------------------------------------------------

{
  const bytes = W.encodeWav(mono([0.25, 0.5, 0.75]), 44100, 16)
  eq('mono writes one sample per frame', bytes.byteLength, 44 + 3 * 2)
  eq('mono sample 0', raw(bytes, 16, 0), Math.round(0.25 * 32767))
  eq('mono sample 1', raw(bytes, 16, 1), Math.round(0.5 * 32767))
  eq('mono sample 2', raw(bytes, 16, 2), Math.round(0.75 * 32767))
}

{
  // Left is positive, right is negative, so a swapped or dropped channel is
  // obvious rather than something you have to squint at.
  const left = Float32Array.from([0.25, 0.5])
  const right = Float32Array.from([-0.25, -0.5])
  const bytes = W.encodeWav([left, right], 44100, 16)
  eq('stereo writes two samples per frame', bytes.byteLength, 44 + 2 * 2 * 2)
  eq('frame 0 left first', raw(bytes, 16, 0), Math.round(0.25 * 32767))
  eq('frame 0 right second', raw(bytes, 16, 1), Math.round(-0.25 * 32768))
  eq('frame 1 left', raw(bytes, 16, 2), Math.round(0.5 * 32767))
  eq('frame 1 right', raw(bytes, 16, 3), Math.round(-0.5 * 32768))
}

{
  const bytes = W.encodeWav(
    [Float32Array.from([0.5, 0.5, 0.5]), Float32Array.from([0.5])],
    44100,
    16
  )
  eq('a short channel does not shorten the file', bytes.byteLength, 44 + 3 * 2 * 2)
  eq('the short channel is padded with silence', raw(bytes, 16, 3), 0)
  ok('the long channel keeps playing', raw(bytes, 16, 4) > 0)
}

// ---------------------------------------------------------------------------
// Refusals. Each of these would produce a file nothing can open.
// ---------------------------------------------------------------------------

const throws = (fn) => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

ok('no channels is refused', throws(() => W.encodeWav([], 44100, 16)))
ok('a zero sample rate is refused', throws(() => W.encodeWav(mono([0]), 0, 16)))
ok('an odd bit depth is refused', throws(() => W.encodeWav(mono([0]), 44100, 8)))
ok('an empty channel still encodes', W.encodeWav(mono([]), 44100, 16).byteLength === 44)
