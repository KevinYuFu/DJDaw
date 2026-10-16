/**
 * Naming a key.
 *
 * The wheel is checked against its published layout, and every spelling the
 * analyser can answer with has to land on the right pitch class — a note it
 * cannot read would silently lose the key.
 */
import { camelotFor, classicFor, pitchClassOfName } from './.build/musicalKey.mjs'

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

// ------------------------------------------------------------- note names

const NAMES = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6,
  G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11
}
for (const [name, pc] of Object.entries(NAMES)) {
  eq(`${name} is pitch class ${pc}`, pitchClassOfName(name), pc)
}

// Sharps and flats name the same note, because the analyser spells a key
// whichever way that key is normally written.
eq('C# and Db are one note', pitchClassOfName('C#'), pitchClassOfName('Db'))
eq('F# and Gb are one note', pitchClassOfName('F#'), pitchClassOfName('Gb'))
eq('surrounding space is ignored', pitchClassOfName(' A '), 9)
eq('a name that is no note is nothing', pitchClassOfName('H'), -1)
eq('and neither is an empty one', pitchClassOfName(''), -1)

// Every note the analyser can answer with has to reach the wheel.
for (const name of Object.keys(NAMES)) {
  const pc = pitchClassOfName(name)
  ok(`${name} minor lands on the wheel`, /^([1-9]|1[0-2])A$/.test(camelotFor(pc, 'minor')))
  ok(`${name} major lands on the wheel`, /^([1-9]|1[0-2])B$/.test(camelotFor(pc, 'major')))
}
