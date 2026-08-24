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

/**
 * How far apart the windows are written. Half the window: 50% overlap.
 *
 * A quarter would smear a little less, and cost twice as much: every window is
 * two transforms, so the overlap is the whole price of the pass.
 */
export const SYNTH_HOP = 1024

/** A magnitude below this is silence, and its phase is not worth carrying. */
const QUIET = 1e-14

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

    // Squared, because these are only ever compared with each other: finding
    // the peaks needs the order, not the size, and taking a thousand square
    // roots a window to get it is most of a pass.
    for (let k = 0; k <= half; k++) {
      const a = re[k]
      const b = im[k]
      mag[k] = a * a + b * b
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

/** Everything one channel remembers between windows. */
interface ChannelPhase {
  mag: Float64Array
  phase: Float64Array
  lastPhase: Float64Array
  sumPhase: Float64Array
  isPeak: Uint8Array
  owner: Int32Array
  rotRe: Float64Array
  rotIm: Float64Array
  first: boolean
}

function newPhase(half: number): ChannelPhase {
  return {
    mag: new Float64Array(half + 1),
    phase: new Float64Array(half + 1),
    lastPhase: new Float64Array(half + 1),
    sumPhase: new Float64Array(half + 1),
    isPeak: new Uint8Array(half + 1),
    owner: new Int32Array(half + 1),
    rotRe: new Float64Array(half + 1),
    rotIm: new Float64Array(half + 1),
    first: true
  }
}

/**
 * Turn one window's spectrum into the one to lay down, in place.
 *
 * `re` and `im` hold bins 0..half on the way in and on the way out; the caller
 * owns the mirroring and the transforms.
 */
function advanceWindow(
  st: ChannelPhase,
  re: Float64Array,
  im: Float64Array,
  half: number,
  n: number,
  analysisHop: number,
  expected: number
): void {
  const { mag, phase, lastPhase, sumPhase, isPeak, owner, rotRe, rotIm } = st

  for (let k = 0; k <= half; k++) {
    const a = re[k]
    const b = im[k]
    mag[k] = a * a + b * b
  }

  for (let k = 0; k <= half; k++) {
    const left2 = k >= 2 ? mag[k - 2] : -1
    const left1 = k >= 1 ? mag[k - 1] : -1
    const right1 = k + 1 <= half ? mag[k + 1] : -1
    const right2 = k + 2 <= half ? mag[k + 2] : -1
    isPeak[k] = mag[k] > left1 && mag[k] > right1 && mag[k] >= left2 && mag[k] >= right2 ? 1 : 0
  }

  for (let k = 0; k <= half; k++) {
    if (isPeak[k]) phase[k] = Math.atan2(im[k], re[k])
  }

  if (st.first) {
    for (let k = 0; k <= half; k++) {
      sumPhase[k] = phase[k]
      lastPhase[k] = phase[k]
    }
    st.first = false
  } else {
    for (let k = 0; k <= half; k++) {
      if (!isPeak[k]) continue
      const drift = principal(phase[k] - lastPhase[k] - expected * k)
      const trueFreq = (2 * Math.PI * k) / n + drift / analysisHop
      sumPhase[k] += trueFreq * SYNTH_HOP
      lastPhase[k] = phase[k]
    }
  }

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
  }
}

/** Both channels of a stereo file in one set of transforms. */
function stretchPair(left: Float32Array, right: Float32Array, factor: number): Float32Array[] {
  const outLength = Math.max(1, Math.round(left.length * factor))
  if (!(factor > 0) || Math.abs(factor - 1) < 1e-9 || left.length < FFT_SIZE) {
    return [stretchChannel(left, factor), stretchChannel(right, factor)]
  }

  const n = FFT_SIZE
  const half = n >> 1
  const analysisHop = Math.max(1, Math.round(SYNTH_HOP / factor))
  const fft = new FFT(n)
  const window = hannWindow(n)
  const expected = (2 * Math.PI * analysisHop) / n

  const re = new Float32Array(n)
  const im = new Float32Array(n)
  const lRe = new Float64Array(half + 1)
  const lIm = new Float64Array(half + 1)
  const rRe = new Float64Array(half + 1)
  const rIm = new Float64Array(half + 1)
  const lState = newPhase(half)
  const rState = newPhase(half)

  const outL = new Float32Array(outLength + n)
  const outR = new Float32Array(outLength + n)
  const norm = new Float32Array(outLength + n)

  for (
    let readAt = 0, writeAt = 0;
    readAt + n <= left.length;
    readAt += analysisHop, writeAt += SYNTH_HOP
  ) {
    for (let i = 0; i < n; i++) {
      const w = window[i]
      re[i] = left[readAt + i] * w
      im[i] = right[readAt + i] * w
    }
    fft.forward(re, im)

    // Two real spectra were carried through one transform; they come apart by
    // their symmetry, the even part being one channel and the odd the other.
    for (let k = 0; k <= half; k++) {
      const j = (n - k) % n
      const ar = re[k]
      const ai = im[k]
      const br = re[j]
      const bi = -im[j]
      lRe[k] = (ar + br) * 0.5
      lIm[k] = (ai + bi) * 0.5
      rRe[k] = (ai - bi) * 0.5
      rIm[k] = (br - ar) * 0.5
    }

    advanceWindow(lState, lRe, lIm, half, n, analysisHop, expected)
    advanceWindow(rState, rRe, rIm, half, n, analysisHop, expected)

    // Repacked the same way for one inverse transform.
    for (let k = 0; k <= half; k++) {
      re[k] = lRe[k] - rIm[k]
      im[k] = lIm[k] + rRe[k]
      if (k > 0 && k < half) {
        re[n - k] = lRe[k] + rIm[k]
        im[n - k] = -lIm[k] + rRe[k]
      }
    }

    for (let i = 0; i < n; i++) im[i] = -im[i]
    fft.forward(re, im)
    const scale = 1 / n
    for (let i = 0; i < n; i++) {
      const at = writeAt + i
      if (at >= outL.length) break
      const w = window[i]
      outL[at] += re[i] * scale * w
      outR[at] += -im[i] * scale * w
      norm[at] += w * w
    }
  }

  const l = new Float32Array(outLength)
  const r = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const d = norm[i] > 1e-6 ? norm[i] : 1
    l[i] = outL[i] / d
    r[i] = outR[i] / d
  }
  return [l, r]
}

/**
 * Stretch every channel of a file the same way.
 *
 * A stereo file goes through in one pass rather than two. A transform of real
 * audio wastes half of itself on an imaginary part that is always zero, so the
 * left channel rides in the real part and the right in the imaginary one, and
 * the two spectra are separated afterwards by their symmetry. Half the
 * transforms for the same result.
 */
export function stretchChannels(
  channels: readonly Float32Array[],
  factor: number
): Float32Array[] {
  if (channels.length !== 2 || channels[0].length !== channels[1].length) {
    return channels.map((channel) => stretchChannel(channel, factor))
  }
  return stretchPair(channels[0], channels[1], factor)
}
