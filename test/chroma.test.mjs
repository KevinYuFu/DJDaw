/**
 * Turning audio into a chromagram.
 *
 * Fed a note, the right pitch class has to light up; fed a chord, its notes
 * and not others. That is the whole contract the key picker depends on.
 */
import { chromagram, downmix, pitchClassOf } from './.build/chroma.mjs'

const { eq, ok } = globalThis.__t

const RATE = 44100
const C = 0, E = 4, G = 7, A = 9

/** A steady tone, long enough to fill several analysis frames. */
function tone(hz, seconds = 2, rate = RATE) {
  const out = new Float32Array(Math.round(seconds * rate))
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate)
  return out
}

/** Several tones at once, at equal strength. */
function chord(freqs, seconds = 2) {
  const out = new Float32Array(Math.round(seconds * RATE))
  for (const hz of freqs) {
    for (let i = 0; i < out.length; i++) out[i] += Math.sin((2 * Math.PI * hz * i) / RATE) / freqs.length
  }
  return out
}

/** The pitch class holding the most energy. */
const strongest = (c) => c.indexOf(Math.max(...c))

// ------------------------------------------------------- frequency to class

eq('A440 is A', pitchClassOf(440), A)
eq('an octave down is still A', pitchClassOf(220), A)
eq('two octaves up is still A', pitchClassOf(1760), A)
eq('middle C is C', pitchClassOf(261.63), C)
eq('below the range is nothing', pitchClassOf(40), -1)
eq('above the range is nothing', pitchClassOf(5000), -1)
eq('zero is nothing', pitchClassOf(0), -1)

// ----------------------------------------------------------------- one note

eq('a 440 tone is loudest at A', strongest(chromagram(tone(440), RATE)), A)
eq('a 261.63 tone is loudest at C', strongest(chromagram(tone(261.63), RATE)), C)
eq('a 392 tone is loudest at G', strongest(chromagram(tone(392), RATE)), G)

// The same note an octave apart folds to one class.
const low = chromagram(tone(220), RATE)
const high = chromagram(tone(880), RATE)
eq('octaves fold together', strongest(low), strongest(high))

// ------------------------------------------------------------------- a chord

// C major triad: C4 E4 G4.
const triad = chromagram(chord([261.63, 329.63, 392.0]), RATE)
const top3 = [...triad.keys()].sort((a, b) => triad[b] - triad[a]).slice(0, 3).sort((a, b) => a - b)
ok(`a C major triad lights C, E and G (got ${top3})`, top3.join() === [C, E, G].join())

// ------------------------------------------------------------ nothing to hear

const silence = chromagram(new Float32Array(RATE), RATE)
eq('silence has no energy anywhere', silence.reduce((a, b) => a + b, 0), 0)
eq('a signal shorter than a frame gives nothing', chromagram(new Float32Array(100), RATE).reduce((a, b) => a + b, 0), 0)
eq('a zero sample rate gives nothing', chromagram(tone(440), 0).reduce((a, b) => a + b, 0), 0)

// --------------------------------------------------------------- normalising

const sum = chromagram(chord([261.63, 329.63, 392.0]), RATE).reduce((a, b) => a + b, 0)
ok(`a chromagram sums to one (got ${sum.toFixed(6)})`, Math.abs(sum - 1) < 1e-6)

// ---------------------------------------------------------------- downmixing

const left = Float32Array.from([1, 1, 1, 1])
const right = Float32Array.from([-1, -1, 1, 1])
eq('two channels average', Array.from(downmix([left, right])).join(), '0,0,1,1')
eq('one channel passes through', downmix([left]), left)
eq('no channels is empty', downmix([]).length, 0)
