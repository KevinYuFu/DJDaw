/**
 * Naming a key, and picking one from a chromagram.
 *
 * The wheel is checked against its published layout, and the picker is fed the
 * exact profile of each of the twenty-four keys: whatever else it does with
 * real audio, it has to name a key correctly when handed that key's own shape.
 */
import {
  MAJOR_PROFILE,
  MINOR_PROFILE,
  camelotFor,
  classicFor,
  keyFromChroma
} from './.build/musicalKey.mjs'

const { eq, ok } = globalThis.__t

// ------------------------------------------------------------- the wheel

// Pitch classes, C first: C0 Db1 D2 Eb3 E4 F5 Gb6 G7 Ab8 A9 Bb10 B11.
// Majors are the B ring, anchored at C = 8B.
const MAJORS = [
  [0, '8B'], [7, '9B'], [2, '10B'], [9, '11B'], [4, '12B'], [11, '1B'],
  [6, '2B'], [1, '3B'], [8, '4B'], [3, '5B'], [10, '6B'], [5, '7B']
]
for (const [pc, name] of MAJORS) eq(`major ${pc} is ${name}`, camelotFor(pc, 'major'), name)

// Minors are the A ring, anchored at A minor = 8A.
const MINORS = [
  [9, '8A'], [4, '9A'], [11, '10A'], [6, '11A'], [1, '12A'], [8, '1A'],
  [3, '2A'], [10, '3A'], [5, '4A'], [0, '5A'], [7, '6A'], [2, '7A']
]
for (const [pc, name] of MINORS) eq(`minor ${pc} is ${name}`, camelotFor(pc, 'minor'), name)

// A key and its relative share a number and differ only by the letter.
for (const [pc] of MAJORS) {
  const major = camelotFor(pc, 'major')
  const relativeMinor = camelotFor((pc + 9) % 12, 'minor')
  eq(`${major} and its relative share a number`, major.slice(0, -1), relativeMinor.slice(0, -1))
  ok(`${major} is the B side`, major.endsWith('B') && relativeMinor.endsWith('A'))
}

eq('every number is on the wheel', new Set(MAJORS.map(([, n]) => n)).size, 12)
eq('a pitch class past the octave wraps', camelotFor(12, 'major'), camelotFor(0, 'major'))
eq('and a negative one wraps too', camelotFor(-3, 'minor'), camelotFor(9, 'minor'))

// ------------------------------------------------------------ classic names

eq('C major is C', classicFor(0, 'major'), 'C')
eq('A minor is Am', classicFor(9, 'minor'), 'Am')
eq('F# minor spells as Gbm', classicFor(6, 'minor'), 'Gbm')

// -------------------------------------------------- picking a key from chroma

/** `profile` written from `tonic` rather than from C. */
const rotate = (profile, tonic) =>
  Array.from({ length: 12 }, (_, i) => profile[(i - tonic + 12) % 12])

// Handed a key's own profile, the picker has to name that key.
for (let tonic = 0; tonic < 12; tonic++) {
  const major = keyFromChroma(rotate(MAJOR_PROFILE, tonic))
  eq(`the major profile at ${tonic} names itself`, major.camelot, camelotFor(tonic, 'major'))
  eq(`and its mode is major`, major.mode, 'major')

  const minor = keyFromChroma(rotate(MINOR_PROFILE, tonic))
  eq(`the minor profile at ${tonic} names itself`, minor.camelot, camelotFor(tonic, 'minor'))
  eq(`and its mode is minor`, minor.mode, 'minor')
}

// An exact profile is as certain as it gets, and never a relative near-tie.
const exact = keyFromChroma(rotate(MAJOR_PROFILE, 0))
ok('an exact match is confident', exact.confidence > 0.1)
eq('and it is 8B', exact.camelot, '8B')

// ------------------------------------------------------------ nothing to go on

eq('silence names no key', keyFromChroma(new Array(12).fill(0)), null)
eq('the wrong length names no key', keyFromChroma([1, 2, 3]), null)
eq('a negative bin names no key', keyFromChroma([1, -1, ...new Array(10).fill(1)]), null)
eq('NaN names no key', keyFromChroma([NaN, ...new Array(11).fill(1)]), null)

// A flat chromagram has no shape to match, so it cannot pick a key.
const flat = keyFromChroma(new Array(12).fill(1))
ok('a flat chromagram is not confident', flat === null || flat.confidence < 0.05)
