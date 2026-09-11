/**
 * Naming a key.
 *
 * Detection itself is Essentia's, in `analysis/key.worker`; it answers with a
 * note and a mode. Everything here turns that into the names the app shows and
 * the browser sorts on.
 */

/** The twelve pitch classes, C first. */
export const PITCH_CLASSES = 12

/** Major or minor. `A` is minor on the Camelot wheel and `B` is major. */
export type KeyMode = 'major' | 'minor'

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

/** A key, named both ways, with how sure the analysis was. */
export interface DetectedKey {
  /** Camelot name, e.g. `8A`. */
  camelot: string
  /** Classic name, e.g. `Am`. */
  classic: string
  pitchClass: number
  mode: KeyMode
  /** 0-1, as the analyser reported it. */
  confidence: number
}

/**
 * The pitch class of a note name, or -1 when it names no note.
 *
 * Sharps and flats both appear because the analyser spells a key whichever way
 * that key is normally written.
 */
export function pitchClassOfName(name: string): number {
  const found = NOTE_ALIASES[name.trim()]
  return found === undefined ? -1 : found
}

/** Every spelling of a note, to its pitch class. */
const NOTE_ALIASES: Readonly<Record<string, number>> = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  Fb: 4,
  'E#': 5,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
  Cb: 11,
  'B#': 0
}
