/**
 * Self-contained radix-2 FFT, used by the tempo analyser.
 *
 * Layout: the transform is iterative, in place, and split into parallel real
 * and imaginary arrays (element k of the signal is `re[k], im[k]`). Input is
 * first permuted into bit-reversed order, then combined in log2(size) stages of
 * butterflies. All twiddle factors come out of one `size / 2` table read with a
 * per-stage stride, so a transform allocates nothing and recomputes no
 * trigonometry. After `forward`, bin k is `re[k], im[k]`; for real input the
 * bins above `size / 2` are mirrored conjugates, so {@link FFT.magnitudes}
 * returns `size / 2 + 1` of them.
 */
export class FFT {
  /** Transform length. Always a power of two. */
  readonly size: number

  private readonly levels: number
  private readonly rev: Uint32Array
  private readonly cosTable: Float64Array
  private readonly sinTable: Float64Array
  private readonly scratchRe: Float32Array
  private readonly scratchIm: Float32Array

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two >= 2, got ${size}`)
    }
    this.size = size
    this.levels = Math.round(Math.log2(size))

    this.rev = new Uint32Array(size)
    for (let i = 0; i < size; i++) {
      let x = i
      let r = 0
      for (let b = 0; b < this.levels; b++) {
        r = (r << 1) | (x & 1)
        x >>>= 1
      }
      this.rev[i] = r
    }

    // Doubles here even though the signal is single precision: the tables are
    // built once, and keeping them exact stops phase error accumulating across
    // the ten stages of a 1024-point transform.
    const half = size >> 1
    this.cosTable = new Float64Array(half)
    this.sinTable = new Float64Array(half)
    for (let k = 0; k < half; k++) {
      const angle = (-2 * Math.PI * k) / size
      this.cosTable[k] = Math.cos(angle)
      this.sinTable[k] = Math.sin(angle)
    }

    this.scratchRe = new Float32Array(size)
    this.scratchIm = new Float32Array(size)
  }

  /**
   * Forward DFT, in place. Both arrays must be exactly `size` long; on return
   * they hold the real and imaginary parts of the spectrum.
   */
  forward(re: Float32Array, im: Float32Array): void {
    const n = this.size
    if (re.length !== n || im.length !== n) {
      throw new Error(`FFT.forward expects ${n}-element arrays`)
    }

    const rev = this.rev
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        const tr = re[i]
        re[i] = re[j]
        re[j] = tr
        const ti = im[i]
        im[i] = im[j]
        im[j] = ti
      }
    }

    const cos = this.cosTable
    const sin = this.sinTable
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1
      const stride = n / len
      for (let base = 0; base < n; base += len) {
        for (let k = 0; k < half; k++) {
          const w = k * stride
          const wr = cos[w]
          const wi = sin[w]
          const a = base + k
          const b = a + half
          const xr = re[b] * wr - im[b] * wi
          const xi = re[b] * wi + im[b] * wr
          re[b] = re[a] - xr
          im[b] = im[a] - xi
          re[a] += xr
          im[a] += xi
        }
      }
    }
  }

  /**
   * Magnitude spectrum of one real frame: `size / 2 + 1` bins, DC through
   * Nyquist. Pass `out` to reuse a buffer across frames.
   *
   * Not reentrant — the transform runs in scratch buffers owned by the
   * instance, which is what keeps a per-frame STFT allocation free.
   */
  magnitudes(frame: Float32Array, out?: Float32Array): Float32Array {
    const n = this.size
    if (frame.length !== n) {
      throw new Error(`FFT.magnitudes expects a ${n}-element frame`)
    }
    const bins = (n >> 1) + 1
    const dst = out ?? new Float32Array(bins)

    const re = this.scratchRe
    const im = this.scratchIm
    re.set(frame)
    im.fill(0)
    this.forward(re, im)

    // sqrt, not Math.hypot: its overflow guard is unreachable at audio range
    // and costs several times as much per bin.
    for (let k = 0; k < bins; k++) {
      const r = re[k]
      const i = im[k]
      dst[k] = Math.sqrt(r * r + i * i)
    }
    return dst
  }
}

/**
 * Periodic Hann window, the correct variant for overlap-add STFT analysis
 * (`1 - cos(2*pi*n/N)`, not `N - 1`, so consecutive hops sum flat).
 */
export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size)
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size))
  return w
}
