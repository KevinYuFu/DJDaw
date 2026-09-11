/**
 * Turning audio into a chromagram.
 *
 * A chromagram is twelve numbers: how much energy the track spends on each
 * pitch class, C first, with every octave folded together. What note it is
 * matters; which octave it was played in does not. `shared/musicalKey` reads
 * the shape of those twelve numbers to name the key.
 */

import { FFT, hannWindow } from '@renderer/analysis/fft'
import { PITCH_CLASSES } from '@shared/musicalKey'

/**
 * Frame length, at 44.1k about 370ms.
 *
 * Long, because what matters here is telling one semitone from the next rather
 * than catching the moment a note lands. At the bottom of the range a semitone
 * is about eight hertz, which a shorter frame smears across neighbouring bins
 * and turns into the wrong key.
 */
const FRAME = 16384

/**
 * The range a key is heard in.
 *
 * The bottom is above the kick and the sub, which carry weight but no pitch a
 * listener could name. The top is where harmonics and cymbals take over from
 * the notes themselves.
 */
const MIN_HZ = 130
const MAX_HZ = 1760

/**
 * Most frames to transform, however long the track is.
 *
 * A key does not change often, so a few hundred frames spread across the whole
 * track describe it as well as every frame would, and a ten-minute track costs
 * no more than a three-minute one.
 */
const MAX_FRAMES = 600

/** Pitch class of a frequency, C being 0, or -1 when it is out of range. */
export function pitchClassOf(hz: number): number {
  if (!(hz >= MIN_HZ) || hz > MAX_HZ) return -1
  // MIDI 69 is A440; twelve semitones to the octave.
  const semitonesFromA4 = 12 * Math.log2(hz / 440)
  const midi = Math.round(69 + semitonesFromA4)
  return ((midi % PITCH_CLASSES) + PITCH_CLASSES) % PITCH_CLASSES
}

/**
 * The chromagram of one mono signal, normalised to sum to 1.
 *
 * Returns twelve zeros for silence or for a signal too short to fill a frame,
 * which `keyFromChroma` reads as "no key".
 */
export function chromagram(mono: Float32Array, sampleRate: number): number[] {
  const chroma = new Array<number>(PITCH_CLASSES).fill(0)
  if (mono.length < FRAME || !(sampleRate > 0)) return chroma

  const fft = new FFT(FRAME)
  const window = hannWindow(FRAME)
  const frame = new Float32Array(FRAME)
  const bins = (FRAME >> 1) + 1
  const magnitude = new Float32Array(bins)
  const frameChroma = new Array<number>(PITCH_CLASSES).fill(0)

  // Which pitch class each bin belongs to, worked out once rather than per
  // frame: it depends only on the bin and the sample rate.
  const classOfBin = new Int8Array(bins)
  for (let k = 0; k < bins; k++) {
    classOfBin[k] = pitchClassOf((k * sampleRate) / FRAME)
  }

  // Spread the frames across the whole track, so the count is what costs time
  // rather than the length.
  const available = Math.floor(mono.length / FRAME)
  const step = Math.max(1, Math.ceil(available / MAX_FRAMES))

  for (let f = 0; f < available; f += step) {
    const start = f * FRAME
    for (let i = 0; i < FRAME; i++) frame[i] = mono[start + i] * window[i]
    fft.magnitudes(frame, magnitude)

    frameChroma.fill(0)
    for (let k = 0; k < bins; k++) {
      const pc = classOfBin[k]
      if (pc >= 0) frameChroma[pc] += magnitude[k]
    }

    // Each frame counts the same, whatever it was played at. Without this a
    // loud drop decides the key for the whole track and a quiet intro in the
    // same key counts for nothing.
    let loudest = 0
    for (const v of frameChroma) if (v > loudest) loudest = v
    if (loudest <= 0) continue
    for (let i = 0; i < PITCH_CLASSES; i++) chroma[i] += frameChroma[i] / loudest
  }

  let total = 0
  for (const v of chroma) total += v
  if (total <= 0) return new Array<number>(PITCH_CLASSES).fill(0)
  for (let i = 0; i < PITCH_CLASSES; i++) chroma[i] /= total
  return chroma
}

/** One channel out of many, averaged. Key does not live in the stereo image. */
export function downmix(channels: readonly Float32Array[]): Float32Array {
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
