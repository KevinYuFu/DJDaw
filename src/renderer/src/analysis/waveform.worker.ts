/**
 * Three-band waveform analysis.
 *
 * Downmixes to mono, splits that into the low/mid/high bands rekordbox draws in
 * blue/orange/white, and reduces each band to one peak byte per bucket. The
 * filters run forward once only: phase distortion is invisible in a peak
 * envelope, so a forward-backward pass would cost twice as much for nothing.
 *
 * The pass is chunked with a yield between chunks so a long track reports
 * progress as it goes instead of freezing the worker for several seconds.
 */

/**
 * Frames summarised by one bucket. Mirrors `WAVEFORM_BUCKET` in
 * `core/constants.ts`; duplicated rather than imported so the worker does not
 * pull the renderer's module graph in behind it.
 */
const BUCKET_SIZE = 128

/** Band split points in Hz: low < 200, mid 200-2000, high > 2000. */
const LOW_SPLIT_HZ = 200
const HIGH_SPLIT_HZ = 2000

/** Q of one 2-pole section of a Butterworth response. */
const BUTTERWORTH_Q = Math.SQRT1_2

/** Progress messages emitted across the whole file. */
const PROGRESS_STEPS = 40

/**
 * Chunk bounds, in frames. The target is one chunk per progress step; the floor
 * stops a short file being sliced pointlessly thin, the ceiling stops a long one
 * disappearing into a single multi-second chunk. Both are multiples of the
 * bucket size, so a chunk boundary is always a bucket boundary.
 */
const MIN_CHUNK_FRAMES = 1 << 15
const MAX_CHUNK_FRAMES = 1 << 20

export interface WaveformRequest {
  /** One Float32Array per channel. Copies, owned by the worker once transferred. */
  channels: Float32Array[]
  sampleRate: number
}

export type WaveformWorkerMessage =
  /** Fraction of the file analysed so far, 0-1. */
  | { type: 'progress'; ratio: number }
  | {
      type: 'done'
      low: Uint8Array
      mid: Uint8Array
      high: Uint8Array
      bucketSize: number
      bucketCount: number
      sampleRate: number
      /** Absolute sample peak of the source, before band normalisation. */
      peak: number
    }
  | { type: 'error'; message: string }

/** Direct form I biquad: coefficients plus the input and output histories. */
interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
  x1: number
  x2: number
  y1: number
  y2: number
}

/** RBJ cookbook lowpass at `freq`, coefficients pre-divided by a0. */
function lowpass(freq: number, sampleRate: number): Biquad {
  const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * BUTTERWORTH_Q)
  const a0 = 1 + alpha
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0
  }
}

/** RBJ cookbook highpass at `freq`, coefficients pre-divided by a0. */
function highpass(freq: number, sampleRate: number): Biquad {
  const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * BUTTERWORTH_Q)
  const a0 = 1 + alpha
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0
  }
}

/** One sample through a biquad, advancing its state. */
function runBiquad(f: Biquad, x: number): number {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2
  f.x2 = f.x1
  f.x1 = x
  f.y2 = f.y1
  f.y1 = y
  return y
}

// `self` types as a Window because the renderer tsconfig loads the DOM lib
// alongside WebWorker; this module only ever runs inside a worker.
const ctx = self as unknown as DedicatedWorkerGlobalScope

function post(message: WaveformWorkerMessage, transfer?: Transferable[]): void {
  if (transfer) ctx.postMessage(message, transfer)
  else ctx.postMessage(message)
}

function fail(err: unknown): void {
  post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
}

function chunkFrames(frames: number): number {
  const target = Math.ceil(frames / PROGRESS_STEPS)
  const clamped = Math.min(MAX_CHUNK_FRAMES, Math.max(MIN_CHUNK_FRAMES, target))
  return Math.ceil(clamped / BUCKET_SIZE) * BUCKET_SIZE
}

function analyze(req: WaveformRequest): void {
  const { channels, sampleRate } = req
  const channelCount = channels.length
  const frames = channelCount > 0 ? channels[0].length : 0
  const bucketCount = Math.ceil(frames / BUCKET_SIZE)

  // Band peaks are kept as floats and quantised only at the end: the scale
  // factor is not known until the loudest band peak in the file has been seen.
  const lowPeaks = new Float32Array(bucketCount)
  const midPeaks = new Float32Array(bucketCount)
  const highPeaks = new Float32Array(bucketCount)

  const lowFilter = lowpass(LOW_SPLIT_HZ, sampleRate)
  const midLowpass = lowpass(HIGH_SPLIT_HZ, sampleRate)
  const midHighpass = highpass(LOW_SPLIT_HZ, sampleRate)
  const highFilter = highpass(HIGH_SPLIT_HZ, sampleRate)

  const perChannel = channelCount > 0 ? 1 / channelCount : 0
  const chunk = chunkFrames(frames)

  let samplePeak = 0
  let bandPeak = 0
  let frame = 0
  let lastProgress = 0

  const finish = (): void => {
    // All three bands share one divisor, so their relative balance survives the
    // trip to bytes. A silent track has no divisor at all, hence the zero.
    const scale = bandPeak > 0 ? 255 / bandPeak : 0
    const low = new Uint8Array(bucketCount)
    const mid = new Uint8Array(bucketCount)
    const high = new Uint8Array(bucketCount)
    for (let i = 0; i < bucketCount; i++) {
      low[i] = Math.min(255, Math.round(lowPeaks[i] * scale))
      mid[i] = Math.min(255, Math.round(midPeaks[i] * scale))
      high[i] = Math.min(255, Math.round(highPeaks[i] * scale))
    }

    post(
      { type: 'done', low, mid, high, bucketSize: BUCKET_SIZE, bucketCount, sampleRate, peak: samplePeak },
      [low.buffer, mid.buffer, high.buffer]
    )
  }

  const processChunk = (): void => {
    try {
      const chunkEnd = Math.min(frames, frame + chunk)
      while (frame < chunkEnd) {
        const bucketEnd = Math.min(chunkEnd, frame + BUCKET_SIZE)
        let lowPeak = 0
        let midPeak = 0
        let highPeak = 0

        for (let i = frame; i < bucketEnd; i++) {
          let sum = 0
          for (let c = 0; c < channelCount; c++) {
            const s = channels[c][i]
            const mag = s < 0 ? -s : s
            if (mag > samplePeak) samplePeak = mag
            sum += s
          }
          const mono = sum * perChannel

          const low = runBiquad(lowFilter, mono)
          const mid = runBiquad(midHighpass, runBiquad(midLowpass, mono))
          const high = runBiquad(highFilter, mono)

          const lowMag = low < 0 ? -low : low
          const midMag = mid < 0 ? -mid : mid
          const highMag = high < 0 ? -high : high
          if (lowMag > lowPeak) lowPeak = lowMag
          if (midMag > midPeak) midPeak = midMag
          if (highMag > highPeak) highPeak = highMag
        }

        const bucket = frame / BUCKET_SIZE
        lowPeaks[bucket] = lowPeak
        midPeaks[bucket] = midPeak
        highPeaks[bucket] = highPeak
        if (lowPeak > bandPeak) bandPeak = lowPeak
        if (midPeak > bandPeak) bandPeak = midPeak
        if (highPeak > bandPeak) bandPeak = highPeak

        frame = bucketEnd
      }

      if (frame >= frames) {
        finish()
        return
      }

      const reached = Math.floor((frame / frames) * PROGRESS_STEPS)
      if (reached > lastProgress) {
        lastProgress = reached
        post({ type: 'progress', ratio: frame / frames })
      }
      // Yield, so the progress message goes out and the worker stays alive to
      // incoming messages instead of monopolising the thread for the whole file.
      setTimeout(processChunk, 0)
    } catch (err) {
      fail(err)
    }
  }

  processChunk()
}

ctx.onmessage = (event: MessageEvent<WaveformRequest>): void => {
  try {
    analyze(event.data)
  } catch (err) {
    fail(err)
  }
}
