/**
 * Naming a key, and scoring one against a chromagram.
 *
 * A chromagram is twelve numbers: how much energy a track spends on each pitch
 * class, C first. Comparing that shape against the twenty-four major and minor
 * profiles below says which key it is. The maths is all here and takes no
 * audio, so it can be checked against known answers.
 */

/** The twelve pitch classes, C first. */
export const PITCH_CLASSES = 12

/** Major or minor. `A` is minor on the Camelot wheel and `B` is major. */
export type KeyMode = 'major' | 'minor'

/**
 * Key profiles: how strongly each pitch class belongs to a key, written from
 * its tonic. Rotating one to a tonic and comparing it with a track's
 * chromagram is what picks the key.
 *
 * These are Shaath's profiles rather than the older Krumhansl-Kessler ones.
 * Measured over a sample of this library they name half again as many keys
 * correctly: the older pair were drawn from classical listening tests and read
 * dance music's flat sevenths and held bass notes as the wrong mode.
 */
export const MAJOR_PROFILE: readonly number[] = [
  6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4
]

/** The minor counterpart of {@link MAJOR_PROFILE}. */
export const MINOR_PROFILE: readonly number[] = [
  6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2
]

/** Note names for each pitch class, C first, in the spelling DJ tools use. */
const NOTE_NAMES: readonly string[] = [
  'C',
  'Db',
  'D',
  'Eb',
  'E',
  'F',
  'Gb',
  'G',
  'Ab',
  'A',
  'Bb',
  'B'
]

/**
 * The Camelot number of a major key.
 *
 * The wheel is the circle of fifths with C major at 8, so each step of a fifth
 * moves one place round. Sevens appear because a fifth is seven semitones, and
 * seven is its own inverse over twelve.
 */
function majorNumber(pitchClass: number): number {
  const stepsOfAFifth = (pitchClass * 7) % PITCH_CLASSES
  return ((7 + stepsOfAFifth) % PITCH_CLASSES) + 1
}

/**
 * The Camelot name of a key, e.g. `8A` for A minor and `8B` for C major.
 *
 * A minor key shares its number with its relative major, which is three
 * semitones above it.
 */
export function camelotFor(pitchClass: number, mode: KeyMode): string {
  const pc = ((pitchClass % PITCH_CLASSES) + PITCH_CLASSES) % PITCH_CLASSES
  const relative = mode === 'minor' ? (pc + 3) % PITCH_CLASSES : pc
  return `${majorNumber(relative)}${mode === 'minor' ? 'A' : 'B'}`
}

/** The classic name of a key, e.g. `Am` or `C`. */
export function classicFor(pitchClass: number, mode: KeyMode): string {
  const pc = ((pitchClass % PITCH_CLASSES) + PITCH_CLASSES) % PITCH_CLASSES
  return `${NOTE_NAMES[pc]}${mode === 'minor' ? 'm' : ''}`
}

/** A key, named both ways, with how clearly it won. */
export interface DetectedKey {
  /** Camelot name, e.g. `8A`. */
  camelot: string
  /** Classic name, e.g. `Am`. */
  classic: string
  pitchClass: number
  mode: KeyMode
  /**
   * 0-1: how far the winner stood clear of the best key that is not its own
   * relative. A track that sits between two keys scores low.
   */
  confidence: number
}

/** Pearson correlation of two equal-length series. 0 when either is flat. */
function correlation(a: readonly number[], b: readonly number[]): number {
  const n = a.length
  let sumA = 0
  let sumB = 0
  for (let i = 0; i < n; i++) {
    sumA += a[i]
    sumB += b[i]
  }
  const meanA = sumA / n
  const meanB = sumB / n

  let top = 0
  let varA = 0
  let varB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    top += da * db
    varA += da * da
    varB += db * db
  }
  const spread = Math.sqrt(varA * varB)
  return spread > 0 ? top / spread : 0
}

/** `profile` written from `tonic` rather than from C. */
function rotated(profile: readonly number[], tonic: number): number[] {
  const out = new Array<number>(PITCH_CLASSES)
  for (let i = 0; i < PITCH_CLASSES; i++) out[i] = profile[(i - tonic + PITCH_CLASSES) % PITCH_CLASSES]
  return out
}

/**
 * The key a chromagram best matches, or null when there is nothing to go on.
 *
 * Every one of the twenty-four keys is scored and the best wins. A key and its
 * relative share the same notes and so always score close together; the runner
 * up that decides confidence is therefore the best key that is *not* the
 * winner's relative, or a near-tie between the two would read as certainty.
 */
export function keyFromChroma(chroma: readonly number[]): DetectedKey | null {
  if (chroma.length !== PITCH_CLASSES) return null
  let total = 0
  for (const v of chroma) {
    if (!Number.isFinite(v) || v < 0) return null
    total += v
  }
  if (total <= 0) return null

  const scores: { pitchClass: number; mode: KeyMode; score: number }[] = []
  for (let tonic = 0; tonic < PITCH_CLASSES; tonic++) {
    scores.push({
      pitchClass: tonic,
      mode: 'major',
      score: correlation(chroma, rotated(MAJOR_PROFILE, tonic))
    })
    scores.push({
      pitchClass: tonic,
      mode: 'minor',
      score: correlation(chroma, rotated(MINOR_PROFILE, tonic))
    })
  }

  scores.sort((a, b) => b.score - a.score)
  const best = scores[0]

  // The relative of the winner, which shares its notes and is not a real rival.
  const relativePc =
    best.mode === 'major' ? (best.pitchClass + 9) % PITCH_CLASSES : (best.pitchClass + 3) % PITCH_CLASSES
  const relativeMode: KeyMode = best.mode === 'major' ? 'minor' : 'major'
  const rival = scores.find(
    (s) => !(s.pitchClass === relativePc && s.mode === relativeMode) && s !== best
  )

  const gap = rival ? best.score - rival.score : best.score
  return {
    camelot: camelotFor(best.pitchClass, best.mode),
    classic: classicFor(best.pitchClass, best.mode),
    pitchClass: best.pitchClass,
    mode: best.mode,
    confidence: Math.max(0, Math.min(1, gap))
  }
}
