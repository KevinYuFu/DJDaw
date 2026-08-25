import { DEFAULT_BEATS_PER_BAR } from '@renderer/core/beatgrid'
import { clamp } from '@renderer/core/format'
import type { TempoResult } from './bpm'
import { FFT, hannWindow } from './fft'

/**
 * Tempo and downbeat detection.
 *
 * Spectral-flux onset envelope → pulse-train tempo search → phase search →
 * downbeat from the kick drum. The search is exhaustive, and runs once at
 * import time. Beat jump, quantise, loops and hot cue snapping all hang off
 * the grid it produces.
 *
 * The downbeat step counts two kinds of kick; see {@link barPhaseFromKicks}.
 */

export interface BpmRequest {
  /** One Float32Array per channel, transferred from the main thread. */
  channels: Float32Array[]
  sampleRate: number
}

export type BpmWorkerMessage =
  | { type: 'progress'; ratio: number }
  | { type: 'done'; result: TempoResult }
  | { type: 'error'; message: string }

const FFT_SIZE = 1024
const HOP = 256
/** Bins under this go into the second, kick-weighted envelope. */
const LOW_BAND_HZ = 150
/**
 * Spectral flux from a Hann-windowed transient peaks when the transient sits
 * `3N/4 - H/2` samples into the analysis window — that is where the window's
 * taper falls off fastest from one hop to the next, so that is where the
 * frame-to-frame magnitude difference is largest. Adding the lag back turns a
 * flux frame index into the time of the transient that caused it; without it
 * every beat in the grid would land ~15 ms early.
 */
const FLUX_LAG = 0.75 * FFT_SIZE - HOP / 2

const MIN_BPM = 70
const MAX_BPM = 190
const COARSE_STEP = 0.1
const FINE_STEP = 0.01
/** Half-width of the fine search around the coarse winner, in BPM. */
const FINE_WINDOW = 1.0
/** Tempo range a DJ expects to see on the display; used to resolve octaves. */
const OCTAVE_LO = 85
const OCTAVE_HI = 175
/**
 * How close the in-range octave's whole-track fit must come to the winning
 * one before the display range is allowed to move the tempo onto it. On a
 * click track a genuinely wrong octave fits at around 0.7 of the right one,
 * while the two readings of an ambiguous backbeat pattern sit above 0.9, so
 * the line falls between them with room on either side.
 */
const OCTAVE_TIE_RATIO = 0.85
/** Bounds on the coarse phase search; see {@link phaseStepsFor}. */
const MIN_PHASE_STEPS = 24
const MAX_PHASE_STEPS = 256
/** Offsets tried across one beat once the tempo is settled. */
const PHASE_STEPS_FINE = 200
/**
 * Length of a coarse-search segment. Each segment gets its own phase, which
 * keeps the coarse tempo peak broad enough to be found on a 0.1 BPM grid and
 * stops a track that drifts by a hair from scoring zero everywhere.
 */
const SEGMENT_BEATS = 64
/** Moving-mean window for envelope normalisation. */
const NORM_WINDOW_SEC = 1.5
/**
 * How much more kick-band energy the half-beat-shifted grid must carry before
 * the beat phase is moved onto it. Well above 1 so that a track with no usable
 * low end keeps the phase the onset envelope chose.
 */
const OFFBEAT_MARGIN = 1.25
/** Q of every biquad here: Butterworth, so nothing rings or overshoots. */
const FILTER_Q = Math.SQRT1_2
/** Cutoff of the downbeat chain's first low-pass. Kick drums live under it. */
const KICK_BAND_HZ = 150
/** Cutoff of the downbeat chain's envelope smoother. */
const KICK_ENVELOPE_HZ = 5
/** Rate the kick envelope is decimated to before peak picking, in Hz. */
const KICK_ENV_RATE = 1000
/** Closest two kick peaks may sit, in seconds. Tighter than a 32nd at 190 BPM. */
const KICK_MIN_GAP_SEC = 0.04
/** A gap this many beats long with no kick is a break. */
const BREAK_BEATS = 8
/** How far a kick-to-kick gap may sit from a beat multiple, in beats. */
const GAP_TOLERANCE = 0.1
/** Beat multiples a kick pattern may use: eighths, beats, half notes. */
const GAP_MULTIPLES = [0.5, 1, 2]
/** Vote weight for the first kick in the track. */
const TRACK_START_WEIGHT = 2
/** Vote weight for the first kick out of a break. Half, as the patent has it. */
const BREAK_EXIT_WEIGHT = 1
/** A rival tempo must be at least this far away to count as the runner-up. */
const RUNNER_UP_GUARD_BPM = 2
/** Shortest input worth analysing, in beats at the slowest candidate tempo. */
const MIN_ANALYSIS_BEATS = 8

/**
 * Returned when there is not enough audio to measure anything. The decks still
 * need a usable grid, so hand back a neutral tempo with zero confidence rather
 * than a number we did not actually detect.
 */
const FALLBACK: TempoResult = { bpm: 120, firstBeatTime: 0, confidence: 0 }

interface Envelopes {
  /** Full-band onset envelope, normalised. */
  onset: Float32Array
  /** Onset envelope restricted to the kick band, normalised. */
  low: Float32Array
  /** Envelope samples per second. */
  rate: number
  /** Mean of `onset`, the level a pulse train picks up by pure chance. */
  mean: number
}

interface PhaseFit {
  /** Summed envelope energy on the pulses. */
  score: number
  /** Winning offset, in envelope samples. */
  offset: number
  /** How many pulses were summed — identical for every offset tried. */
  pulses: number
}

interface TempoFit extends PhaseFit {
  bpm: number
  /** {@link combStrength} of `score`, which is what compares across tempi. */
  strength: number
}

function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const n = channels[0].length
  const out = new Float32Array(n)
  for (const ch of channels) {
    const len = Math.min(n, ch.length)
    for (let i = 0; i < len; i++) out[i] += ch[i]
  }
  const gain = 1 / channels.length
  for (let i = 0; i < n; i++) out[i] *= gain
  return out
}

/**
 * Phase offsets to try across one beat of `period` envelope samples: one per
 * envelope sample.
 *
 * One offset per envelope sample. At the true tempo the pulses are exactly
 * periodic, so a coarser step repeats one offset error on every beat and scores
 * the correct tempo below its neighbours. Finer than the envelope adds nothing,
 * and the cost per candidate is tempo-independent.
 */
function phaseStepsFor(period: number): number {
  return clamp(Math.ceil(period), MIN_PHASE_STEPS, MAX_PHASE_STEPS)
}

/** Envelope samples per beat at `bpm`. */
function beatSamples(bpm: number, rate: number): number {
  return (60 / bpm) * rate
}

/** Envelope index -> seconds into the file, transient lag included. */
function envTime(index: number, sampleRate: number): number {
  return (index * HOP + FLUX_LAG) / sampleRate
}

/** Linear read of the envelope at a fractional index. */
function sampleAt(env: Float32Array, x: number): number {
  if (x < 0) return 0
  const i = x | 0
  if (i >= env.length) return 0
  if (i + 1 >= env.length) return env[i]
  return env[i] + (env[i + 1] - env[i]) * (x - i)
}

/**
 * Half-wave rectified spectral flux, plus the same measure restricted to the
 * kick band. Reported progress covers the STFT, which dominates the run.
 */
function buildEnvelopes(
  mono: Float32Array,
  sampleRate: number,
  report: (ratio: number) => void
): Envelopes {
  const rate = sampleRate / HOP
  const frames = mono.length >= FFT_SIZE ? Math.floor((mono.length - FFT_SIZE) / HOP) + 1 : 0
  const onset = new Float32Array(frames)
  const low = new Float32Array(frames)
  if (frames === 0) return { onset, low, rate, mean: 0 }

  const bins = (FFT_SIZE >> 1) + 1
  const lowBins = Math.min(bins - 1, Math.max(2, Math.ceil((LOW_BAND_HZ * FFT_SIZE) / sampleRate)))
  const fft = new FFT(FFT_SIZE)
  const window = hannWindow(FFT_SIZE)
  const frame = new Float32Array(FFT_SIZE)
  let mag = new Float32Array(bins)
  let prev = new Float32Array(bins)

  for (let f = 0; f < frames; f++) {
    const start = f * HOP
    for (let j = 0; j < FFT_SIZE; j++) frame[j] = mono[start + j] * window[j]
    fft.magnitudes(frame, mag)

    let flux = 0
    let lowFlux = 0
    // Bin 0 is DC: no rhythm in it, and any file offset would leak straight in.
    for (let k = 1; k < bins; k++) {
      const d = mag[k] - prev[k]
      if (d > 0) {
        flux += d
        if (k <= lowBins) lowFlux += d
      }
    }
    onset[f] = flux
    low[f] = lowFlux

    const swap = prev
    prev = mag
    mag = swap

    if ((f & 1023) === 0) report(f / frames)
  }

  // Frame 0 is measured against silence, so it always looks like a huge onset.
  onset[0] = 0
  low[0] = 0

  normalise(onset, rate)
  normalise(low, rate)

  let sum = 0
  for (let i = 0; i < onset.length; i++) sum += onset[i]
  return { onset, low, rate, mean: sum / onset.length }
}

/**
 * Local adaptive normalisation, in place: subtract a moving mean, half-wave
 * rectify, divide by the standard deviation, so a quiet intro and a loud drop
 * contribute equally to the tempo search.
 */
function normalise(env: Float32Array, rate: number): void {
  const n = env.length
  if (n === 0) return

  const half = Math.max(1, Math.round((NORM_WINDOW_SEC * rate) / 2))
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i]

  for (let i = 0; i < n; i++) {
    const a = i - half > 0 ? i - half : 0
    const b = i + half + 1 < n ? i + half + 1 : n
    const local = (prefix[b] - prefix[a]) / (b - a)
    const v = env[i] - local
    env[i] = v > 0 ? v : 0
  }

  let sum = 0
  for (let i = 0; i < n; i++) sum += env[i]
  const mean = sum / n
  let variance = 0
  for (let i = 0; i < n; i++) {
    const d = env[i] - mean
    variance += d * d
  }
  const sd = Math.sqrt(variance / n)
  if (sd > 1e-12) {
    const g = 1 / sd
    for (let i = 0; i < n; i++) env[i] *= g
  }
}

/**
 * Best pulse-train alignment inside `[from, to)`, by summed onset strength.
 *
 * Every offset is scored over the same number of pulses, so an offset cannot
 * win simply by squeezing one extra beat into the window.
 */
function bestPhase(
  env: Float32Array,
  from: number,
  to: number,
  period: number,
  steps: number
): PhaseFit {
  const pulses = Math.floor((to - from) / period)
  if (pulses < 1) return { score: 0, offset: from, pulses: 0 }

  let bestScore = -Infinity
  let bestOffset = from
  for (let s = 0; s < steps; s++) {
    const offset = from + (s * period) / steps
    let acc = 0
    for (let k = 0; k < pulses; k++) acc += sampleAt(env, offset + k * period)
    if (acc > bestScore) {
      bestScore = acc
      bestOffset = offset
    }
  }
  return { score: bestScore, offset: bestOffset, pulses }
}

/** Mean envelope strength of a pulse train at a fixed offset and period. */
function pulseMean(env: Float32Array, offset: number, period: number): number {
  let acc = 0
  let n = 0
  for (let x = offset; x < env.length; x += period) {
    acc += sampleAt(env, x)
    n++
  }
  return n > 0 ? acc / n : 0
}

/**
 * Turn a raw pulse-train sum into a score comparable across tempi.
 *
 * Subtracting `pulses * mean` removes the strength a train of that length
 * collects from the envelope by chance, so a hypothesis that fits nothing
 * scores about zero however many pulses it has. Dividing by the square root of
 * the pulse count — the L2 norm of the template — is what a matched filter
 * does, and it is what keeps the metrical level honest: dividing by the count
 * instead would reward any *subset* of the real beats, so a track with a strong
 * backbeat would always read as half its tempo, while not normalising at all
 * would simply reward the fastest candidate. With this, the true tempo beats
 * both its half and its double as long as the beats an octave error would drop
 * carry more than about 40% of the strength of the ones it keeps — below that
 * the track genuinely reads as half-time, and the confidence collapses to say
 * so.
 */
function combStrength(sum: number, pulses: number, mean: number): number {
  return pulses > 0 ? (sum - pulses * mean) / Math.sqrt(pulses) : 0
}

/**
 * Coarse tempo score: pulse-train strength with the phase re-fitted every
 * {@link SEGMENT_BEATS} beats. Re-fitting is what lets this survive a track
 * whose tempo wanders slightly, and it broadens the peak enough that a 0.1 BPM
 * grid cannot step straight over it — fitted across a whole track, a peak is
 * only a few hundredths of a BPM wide.
 */
function driftTolerantScore(env: Envelopes, period: number): number {
  const steps = phaseStepsFor(period)
  const segment = period * SEGMENT_BEATS
  let total = 0
  let pulses = 0
  for (let start = 0; start < env.onset.length; start += segment) {
    const end = Math.min(start + segment, env.onset.length)
    // A stub of a tail segment says nothing about tempo. Stop here.
    if (end - start < period * 4) break
    const fit = bestPhase(env.onset, start, end, period, steps)
    total += fit.score
    pulses += fit.pulses
  }
  return combStrength(total, pulses, env.mean)
}

/** Strength of one tempo across the whole envelope under a single phase. */
function wholeTrackFit(env: Envelopes, bpm: number, steps: number): TempoFit {
  const fit = bestPhase(env.onset, 0, env.onset.length, beatSamples(bpm, env.rate), steps)
  return { ...fit, bpm, strength: combStrength(fit.score, fit.pulses, env.mean) }
}

/**
 * Refine a coarse tempo to 0.01 BPM. Unlike the coarse pass this fits a single
 * phase across the entire track, which makes the peak razor sharp: a hundredth
 * of a BPM out and the pulses have visibly slid off the beats by the last
 * chorus. Candidates are snapped to the 0.01 grid so the search space is
 * exactly the set of values we can report.
 */
function refineTempo(env: Envelopes, guess: number): TempoFit {
  const steps = Math.round((2 * FINE_WINDOW) / FINE_STEP) + 1
  let best: TempoFit | null = null
  for (let i = 0; i < steps; i++) {
    const bpm = Math.round((guess - FINE_WINDOW + i * FINE_STEP) * 100) / 100
    if (bpm <= 0) continue
    const fit = wholeTrackFit(env, bpm, PHASE_STEPS_FINE)
    if (best === null || fit.strength > best.strength) best = fit
  }
  return best ?? wholeTrackFit(env, guess, PHASE_STEPS_FINE)
}

/**
 * Pick between a tempo and its octave.
 *
 * 85-175 is the range a DJ reads a track in, but it is a tie-break, not
 * evidence. Letting it win outright halves or doubles every track whose real
 * tempo lies outside it — a 180 BPM track would come back as 90, with a grid
 * missing every other beat, which is worse than an unusual number on the
 * display. So the stronger fit wins, and the range only decides when the
 * in-range octave explains the onsets nearly as well: within
 * {@link OCTAVE_TIE_RATIO}, the level the correlation preferred is not a clear
 * winner and the two are genuinely ambiguous.
 */
function pickOctave(a: TempoFit, b: TempoFit): TempoFit {
  const best = b.strength > a.strength ? b : a
  const other = best === a ? b : a
  if (best.bpm >= OCTAVE_LO && best.bpm <= OCTAVE_HI) return best
  if (other.bpm < OCTAVE_LO || other.bpm > OCTAVE_HI) return best
  return best.strength > 0 && other.strength >= best.strength * OCTAVE_TIE_RATIO ? other : best
}


interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** Direct-form-I coefficients for a 2nd-order low-pass (RBJ cookbook). */
function lowPassCoeffs(cutoff: number, sampleRate: number): Biquad {
  const w = (2 * Math.PI * cutoff) / sampleRate
  const cosW = Math.cos(w)
  const alpha = Math.sin(w) / (2 * FILTER_Q)
  const a0 = 1 + alpha
  const shared = (1 - cosW) / 2
  return {
    b0: shared / a0,
    b1: (1 - cosW) / a0,
    b2: shared / a0,
    a1: (-2 * cosW) / a0,
    a2: (1 - alpha) / a0
  }
}

/**
 * Delay a {@link lowPassCoeffs} section adds to anything well below its cutoff,
 * in seconds. A kick envelope is all DC and a few Hz, so this is the whole
 * delay of the section for our purposes.
 */
function sectionDelay(cutoff: number): number {
  return 1 / (2 * Math.PI * FILTER_Q * cutoff)
}

interface KickEnvelope {
  /** Smoothed kick-band level. */
  env: Float32Array
  /** Envelope samples per second. */
  rate: number
  /** Seconds the filter chain delays the envelope by. */
  delay: number
}

/**
 * The patent's signal chain: 2nd-order low-pass at 150 Hz, rectify, 2nd-order
 * low-pass at 5 Hz. What comes out is one smooth bump per kick drum.
 *
 * Both filters run in one pass over the samples and the result is decimated to
 * {@link KICK_ENV_RATE}, which is far above the 5 Hz already in the signal and
 * keeps the peak search over a full track in the tens of thousands of samples.
 */
function kickEnvelope(mono: Float32Array, sampleRate: number): KickEnvelope {
  const band = lowPassCoeffs(KICK_BAND_HZ, sampleRate)
  const smooth = lowPassCoeffs(KICK_ENVELOPE_HZ, sampleRate)
  const decimate = Math.max(1, Math.round(sampleRate / KICK_ENV_RATE))
  const rate = sampleRate / decimate
  const env = new Float32Array(Math.ceil(mono.length / decimate))

  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  let u1 = 0
  let u2 = 0
  let v1 = 0
  let v2 = 0
  let w = 0
  for (let i = 0; i < mono.length; i++) {
    const x = mono[i]
    const y = band.b0 * x + band.b1 * x1 + band.b2 * x2 - band.a1 * y1 - band.a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y

    const u = y < 0 ? -y : y
    const v = smooth.b0 * u + smooth.b1 * u1 + smooth.b2 * u2 - smooth.a1 * v1 - smooth.a2 * v2
    u2 = u1
    u1 = u
    v2 = v1
    v1 = v

    if (i % decimate === 0 && w < env.length) env[w++] = v
  }

  return { env, rate, delay: sectionDelay(KICK_BAND_HZ) + sectionDelay(KICK_ENVELOPE_HZ) }
}

interface KickPeak {
  /** Seconds into the file. */
  time: number
  /** Envelope level at the peak. */
  level: number
}

/**
 * Kick hits: peaks of {@link kickEnvelope}, with everything below the mean peak
 * level thrown away so only real kicks survive.
 *
 * The filter chain is causal, so every bump sits a fixed distance late. That
 * distance is subtracted here — left in, a 5 Hz smoother alone puts every kick
 * 45 ms behind the beat it was played on.
 */
function findKicks(mono: Float32Array, sampleRate: number): KickPeak[] {
  const { env, rate, delay } = kickEnvelope(mono, sampleRate)
  const guard = Math.max(1, Math.round(KICK_MIN_GAP_SEC * rate))
  const peaks: KickPeak[] = []

  for (let i = 1; i < env.length - 1; i++) {
    const level = env[i]
    if (level <= env[i - 1] || level < env[i + 1]) continue
    const from = i - guard > 0 ? i - guard : 0
    const to = i + guard < env.length - 1 ? i + guard : env.length - 1
    let highest = true
    for (let j = from; j <= to; j++) {
      if (env[j] > level) {
        highest = false
        break
      }
    }
    if (!highest) continue
    const time = i / rate - delay
    peaks.push({ time: time > 0 ? time : 0, level })
    i += guard
  }

  if (peaks.length === 0) return peaks
  let sum = 0
  for (const p of peaks) sum += p.level
  const mean = sum / peaks.length
  return peaks.filter((p) => p.level >= mean)
}

/** True when `gap` sits within {@link GAP_TOLERANCE} beats of a kick spacing. */
function gapFitsBeat(gap: number, beatSec: number): boolean {
  const slack = GAP_TOLERANCE * beatSec
  for (const multiple of GAP_MULTIPLES) {
    if (Math.abs(gap - multiple * beatSec) <= slack) return true
  }
  return false
}

/**
 * Bar phase by Pioneer's method (JP6071274B2): which beat of the bar the
 * downbeat sits on, or `null` if no kick said anything.
 *
 * Only two kicks in a whole track are treated as evidence — the first one, and
 * the first one after each break. That is the patent's insight, and it is why
 * this beats summing energy over every beat 1. A producer can put a kick
 * anywhere, but the moment the drums *enter* is almost always the top of a bar,
 * and a plain energy sum drowns that one moment under thousands of ordinary
 * kicks. Counting only entries means an eight-bar ambient intro is decided by
 * the single hit that ends it.
 *
 * A kick only votes if the next kick follows an eighth, a beat or a half note
 * later. That rejects a stray one-off stab, which is not a drum entry at all.
 */
function barPhaseFromKicks(
  peaks: KickPeak[],
  beat0: number,
  beatSec: number,
  beatsPerBar: number
): number | null {
  const votes = new Float64Array(beatsPerBar)
  const breakGap = BREAK_BEATS * beatSec
  let voted = false

  for (let k = 0; k < peaks.length; k++) {
    const trackStart = k === 0
    const breakExit = k > 0 && peaks[k].time - peaks[k - 1].time >= breakGap
    if (!trackStart && !breakExit) continue

    const next = peaks[k + 1]
    if (next === undefined) continue
    if (!gapFitsBeat(next.time - peaks[k].time, beatSec)) continue

    const beat = Math.round((peaks[k].time - beat0) / beatSec)
    const slot = ((beat % beatsPerBar) + beatsPerBar) % beatsPerBar
    votes[slot] += peaks[k].level * (trackStart ? TRACK_START_WEIGHT : BREAK_EXIT_WEIGHT)
    voted = true
  }

  if (!voted) return null
  let best = 0
  for (let i = 1; i < beatsPerBar; i++) {
    if (votes[i] > votes[best]) best = i
  }
  return best
}

/**
 * Bar phase from low-band onset energy: of the `beatsPerBar` candidates, the
 * one whose beats carry the most kick-band flux.
 *
 * The fallback for a track with no kick drum to count. An average over the
 * track, not evidence about any one bar line.
 */
function barPhaseFromLowBand(
  low: Float32Array,
  phase: number,
  period: number,
  beatsPerBar: number
): number {
  let best = 0
  let bestScore = -1
  for (let b = 0; b < beatsPerBar; b++) {
    const score = pulseMean(low, phase + b * period, period * beatsPerBar)
    if (score > bestScore) {
      bestScore = score
      best = b
    }
  }
  return best
}

/**
 * Full analysis of a mono signal. The worker's message handler is the
 * production entry point; this is exported so the tests can drive it directly.
 */
export function detect(
  mono: Float32Array,
  sampleRate: number,
  report: (ratio: number) => void = () => {}
): TempoResult {
  const env = buildEnvelopes(mono, sampleRate, (r) => report(r * 0.6))
  const { onset, low, rate } = env
  if (onset.length < MIN_ANALYSIS_BEATS * beatSamples(MIN_BPM, rate)) return FALLBACK

  const candidates = Math.round((MAX_BPM - MIN_BPM) / COARSE_STEP) + 1
  const coarse = new Float64Array(candidates)
  let bestIndex = 0
  for (let i = 0; i < candidates; i++) {
    const bpm = MIN_BPM + i * COARSE_STEP
    coarse[i] = driftTolerantScore(env, beatSamples(bpm, rate))
    if (coarse[i] > coarse[bestIndex]) bestIndex = i
    if ((i & 31) === 0) report(0.6 + 0.3 * (i / candidates))
  }
  if (coarse[bestIndex] <= 0) return FALLBACK

  const peak = refineTempo(env, MIN_BPM + bestIndex * COARSE_STEP)
  report(0.95)
  let winner = peak
  if (peak.bpm < OCTAVE_LO) winner = pickOctave(peak, refineTempo(env, peak.bpm * 2))
  else if (peak.bpm > OCTAVE_HI) winner = pickOctave(peak, refineTempo(env, peak.bpm / 2))

  // Report the rounded tempo, then derive the phase from that same rounded
  // value so the grid we hand back is internally consistent.
  const bpm = Math.round(winner.bpm * 100) / 100
  const period = beatSamples(bpm, rate)
  let phase = bestPhase(onset, 0, onset.length, period, PHASE_STEPS_FINE).offset

  // A wall of offbeat hats can out-flux the kicks — broadband noise spreads
  // across hundreds of bins where a 50 Hz kick moves three — and drag the phase
  // half a beat off, which lands the whole grid between the beats. The kick
  // settles it, so move only when the low band is decisively better off there.
  if (pulseMean(low, phase + period / 2, period) > OFFBEAT_MARGIN * pulseMean(low, phase, period)) {
    phase += period / 2
  }

  // Downbeat: which beat of the bar is beat 1, voted on by the kicks that start
  // the track and end each break. Tempo and beat phase are already settled and
  // are not touched.
  const beatsPerBar = DEFAULT_BEATS_PER_BAR
  const beatSec = 60 / bpm
  const beat0 = envTime(phase, sampleRate)
  const kickPhase = barPhaseFromKicks(findKicks(mono, sampleRate), beat0, beatSec, beatsPerBar)
  const barPhase = kickPhase ?? barPhaseFromLowBand(low, phase, period, beatsPerBar)

  // Walk the detected downbeat back a bar at a time to the first one at or
  // after t=0, which is where the grid anchors.
  const downbeat = beat0 + barPhase * beatSec
  const barSec = beatsPerBar * beatSec
  const firstBeatTime = downbeat - Math.floor(downbeat / barSec) * barSec

  // Confidence comes from the coarse curve, the only place every tempo was
  // scored on equal terms: how far clear the tempo we are returning sits of
  // the best rival that is not just a neighbouring bin of the same peak.
  //
  // The octave resolution may have moved us off the coarse peak, and that peak
  // is still standing there in the curve. It is not a rival: it is this same
  // grid read at another metrical level, and which level to report was already
  // settled on the whole-track fits, which are sharper than anything the coarse
  // pass can see. Counting it would score the winner against itself and pin the
  // confidence of every octave-resolved track at zero.
  const winnerScore = driftTolerantScore(env, period)
  let runnerUp = 0
  for (let i = 0; i < candidates; i++) {
    const other = MIN_BPM + i * COARSE_STEP
    if (Math.abs(other - bpm) <= RUNNER_UP_GUARD_BPM) continue
    if (Math.abs(other - peak.bpm) <= RUNNER_UP_GUARD_BPM) continue
    if (coarse[i] > runnerUp) runnerUp = coarse[i]
  }
  const confidence = winnerScore > 0 ? clamp((winnerScore - runnerUp) / winnerScore, 0, 1) : 0

  report(1)
  return { bpm, firstBeatTime, confidence }
}

// The renderer tsconfig loads both the DOM and WebWorker libs, so `self` is
// typed as a Window here. Narrowed once.
const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<BpmRequest>): void => {
  let lastPercent = -1
  const report = (ratio: number): void => {
    const percent = Math.floor(clamp(ratio, 0, 1) * 100)
    if (percent <= lastPercent) return
    lastPercent = percent
    ctx.postMessage({ type: 'progress', ratio: percent / 100 } satisfies BpmWorkerMessage)
  }

  try {
    const { channels, sampleRate } = event.data
    const result = detect(downmix(channels), sampleRate, report)
    ctx.postMessage({ type: 'done', result } satisfies BpmWorkerMessage)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.postMessage({ type: 'error', message } satisfies BpmWorkerMessage)
  }
}
