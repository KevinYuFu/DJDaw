import { FFT, hannWindow } from './fft'

/**
 * Time stretching that leaves the pitch alone.
 *
 * A phase vocoder: the audio is cut into overlapping windows, each turned into
 * frequencies, and laid back down at a different spacing. Reading the windows
 * closer together than they are written makes the result longer, and further
 * apart makes it shorter, while every partial keeps the frequency it had.
 *
 * The naive version of this smears transients and sounds watery, because each
 * frequency bin's phase is advanced on its own and the bins that belong to one
 * partial drift apart. The fix here is the one Laroche and Dolson call identity
 * phase locking: the peaks in the spectrum are found, every other bin is
 * treated as belonging to the nearest peak, and its phase is carried along with
 * that peak's rather than advanced by itself.
 *
 * This runs over a whole file once, off the audio thread, rather than inside
 * the deck: a warped track is a second buffer the deck plays at its normal
 * speed, so nothing in the worklet has to keep up with an FFT.
 */

/** Window length. Long enough to resolve a bass partial, short enough to keep drums. */
export const FFT_SIZE = 2048

/** How far apart the windows are written. A quarter of the window: 75% overlap. */
export const SYNTH_HOP = 512

/** A magnitude below this is silence, and its phase is not worth carrying. */
const QUIET = 1e-7

/** Wrap a phase difference into -pi..pi. */
function principal(angle: number): number {
  return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI))
}

/**
 * Stretch one channel so it comes out `factor` times as long.
 *
 * `factor` above 1 makes it longer and slower, below 1 shorter and faster. The
 * pitch is the same either way.
 */
export function stretchChannel(input: Float32Array, factor: number): Float32Array {
  const outLength = Math.max(1, Math.round(input.length * factor))
  if (!(factor > 0) || Math.abs(factor - 1) < 1e-9 || input.length < FFT_SIZE) {
    const same = new Float32Array(outLength)
    same.set(input.subarray(0, Math.min(input.length, outLength)))
    return same
  }

  const n = FFT_SIZE
  const half = n >> 1
  const analysisHop = Math.max(1, Math.round(SYNTH_HOP / factor))
  const fft = new FFT(n)
  const window = hannWindow(n)

  const re = new Float32Array(n)
  const im = new Float32Array(n)
  const mag = new Float64Array(half + 1)
  const phase = new Float64Array(half + 1)
  const lastPhase = new Float64Array(half + 1)
  const sumPhase = new Float64Array(half + 1)
  // The turn each peak's bins get, as a complex number rather than an angle.
  const rotRe = new Float64Array(half + 1)
  const rotIm = new Float64Array(half + 1)
  const isPeak = new Uint8Array(half + 1)
  // Which peak each bin belongs to, so its phase is carried by that peak.
  const owner = new Int32Array(half + 1)
  let firstFrame = true

  const out = new Float32Array(outLength + n)
  const norm = new Float32Array(outLength + n)
  const expected = (2 * Math.PI * analysisHop) / n

  for (let readAt = 0, writeAt = 0; readAt + n <= input.length; readAt += analysisHop, writeAt += SYNTH_HOP) {
    for (let i = 0; i < n; i++) {
      re[i] = input[readAt + i] * window[i]
      im[i] = 0
    }
    fft.forward(re, im)

    // Magnitudes for every bin, but angles only where they are needed: a bin's
    // new phase is its old one turned by however far its peak moved, and that
    // turn is a complex multiply rather than another sine and cosine.
    for (let k = 0; k <= half; k++) {
      const a = re[k]
      const b = im[k]
      mag[k] = Math.sqrt(a * a + b * b)
    }

    // A bin is a peak when it stands above its four neighbours. Everything
    // between two peaks belongs to the nearer of them.
    for (let k = 0; k <= half; k++) {
      const left2 = k >= 2 ? mag[k - 2] : -1
      const left1 = k >= 1 ? mag[k - 1] : -1
      const right1 = k + 1 <= half ? mag[k + 1] : -1
      const right2 = k + 2 <= half ? mag[k + 2] : -1
      isPeak[k] = mag[k] > left1 && mag[k] > right1 && mag[k] >= left2 && mag[k] >= right2 ? 1 : 0
    }

    // The first frame is laid down as it was heard: there is no previous frame
    // to have drifted from, and starting the run anywhere else puts a step in
    // front of the audio.
    for (let k = 0; k <= half; k++) {
      if (isPeak[k]) phase[k] = Math.atan2(im[k], re[k])
    }

    if (firstFrame) {
      for (let k = 0; k <= half; k++) {
        sumPhase[k] = phase[k]
        lastPhase[k] = phase[k]
      }
      firstFrame = false
    } else {
      // Advance each peak by the frequency it is actually running at, which is
      // its bin frequency plus however far its phase has drifted from expected.
      for (let k = 0; k <= half; k++) {
        if (!isPeak[k]) continue
        const drift = principal(phase[k] - lastPhase[k] - expected * k)
        const trueFreq = (2 * Math.PI * k) / n + drift / analysisHop
        sumPhase[k] += trueFreq * SYNTH_HOP
      }
      for (let k = 0; k <= half; k++) {
        if (isPeak[k]) lastPhase[k] = phase[k]
      }
    }

    // Each bin is claimed by the nearer of the peaks either side of it: one
    // sweep out for the peak behind, one back for the peak ahead.
    let behind = -1
    for (let k = 0; k <= half; k++) {
      if (isPeak[k]) behind = k
      owner[k] = behind
    }
    let ahead = -1
    for (let k = half; k >= 0; k--) {
      if (isPeak[k]) ahead = k
      const back = owner[k]
      if (back < 0) owner[k] = ahead
      else if (ahead >= 0 && ahead - k < k - back) owner[k] = ahead
    }

    for (let k = 0; k <= half; k++) {
      if (!isPeak[k]) continue
      const turn = sumPhase[k] - phase[k]
      rotRe[k] = Math.cos(turn)
      rotIm[k] = Math.sin(turn)
    }

    // Every other bin is carried by its peak, keeping the shape of the partial
    // around that peak intact instead of letting its sides wander off.
    for (let k = 0; k <= half; k++) {
      const from = owner[k]
      const a = re[k]
      const b = im[k]
      if (from < 0 || mag[k] < QUIET) {
        re[k] = 0
        im[k] = 0
      } else {
        const c = rotRe[from]
        const d = rotIm[from]
        re[k] = a * c - b * d
        im[k] = a * d + b * c
      }
      if (k > 0 && k < half) {
        re[n - k] = re[k]
        im[n - k] = -im[k]
      }
    }

    // Inverse transform, by conjugating either side of the forward one.
    for (let i = 0; i < n; i++) im[i] = -im[i]
    fft.forward(re, im)
    const scale = 1 / n
    for (let i = 0; i < n; i++) {
      const at = writeAt + i
      if (at >= out.length) break
      const sample = re[i] * scale * window[i]
      out[at] += sample
      norm[at] += window[i] * window[i]
    }
  }

  const result = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    result[i] = norm[i] > 1e-6 ? out[i] / norm[i] : out[i]
  }
  return result
}

/** Stretch every channel of a file the same way. */
export function stretchChannels(
  channels: readonly Float32Array[],
  factor: number
): Float32Array[] {
  return channels.map((channel) => stretchChannel(channel, factor))
}
