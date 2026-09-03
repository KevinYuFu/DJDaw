/**
 * Finding words to take out of a vocal.
 *
 * The transcription is imperfect and always will be, so what matters here is
 * that a word spelt oddly is still caught, and that an ordinary word is not.
 */
import {
  CUT_JOIN_SEC,
  CUT_PAD_SEC,
  cutsFor,
  distance,
  isListed,
  plainly,
  prepareList
} from './.build/censor.mjs'

const { eq, ok } = globalThis.__t

// A stand-in list, so the tests read without printing the real one.
const list = prepareList(['badword', 'rudeness', 'crumb', 'slurword', 'ass'])

// ------------------------------------------------------------ reducing words

eq('case does not matter', plainly('BadWord'), 'badword')
eq('punctuation goes', plainly('bad-word!'), 'badword')
eq('a letter held down comes back to two', plainly('baaaadword'), 'baadword')
eq('a double letter is left alone', plainly('ass'), 'ass')
eq('so a word one letter shorter stays different', plainly('as'), 'as')
eq('lookalike digits become letters', plainly('b4dw0rd'), 'badword')
eq('stars and hashes drop out', plainly('b*dw#rd'), 'bdwrd')
eq('an exclamation is punctuation, not a letter', plainly('badword!'), 'badword')
eq('an empty word reduces to nothing', plainly('!!!'), '')

// ------------------------------------------------------------------ distance

eq('the same word is no distance at all', distance('badword', 'badword'), 0)
eq('one letter changed is one', distance('badword', 'badwerd'), 1)
eq('one letter missing is one', distance('badwor', 'badword'), 1)
ok('a different word is far', distance('badword', 'kindness', 2) > 2)

// ------------------------------------------------------------------ matching

ok('a listed word is caught', isListed('badword', list))
ok('however it is capitalised', isListed('BADWORD', list))
ok('with punctuation on it', isListed('badword,', list))
ok('with a letter held down', isListed('baaadword', list))
ok('written with digits', isListed('b4dw0rd', list))
ok('and misheard by a letter', isListed('badwird', list))
ok('a slur is caught the same way', isListed('slurword', list))

ok('an ordinary word is left alone', !isListed('sandwich', list))
ok('and so is one that merely rhymes', !isListed('kindness', list))

// A word one letter from a listed one, but starting differently, is a
// different word. Without this, `night` on a list takes `right` and `might`
// out of the song with it.
{
  const rhymes = prepareList(['night'])
  ok('the listed word is caught', isListed('night', rhymes))
  ok('but not one that only rhymes with it', !isListed('right', rhymes))
  ok('nor another', !isListed('might', rhymes))
  ok('nor a third', !isListed('light', rhymes))
  ok('while a mishearing of its middle still is', isListed('nighk', rhymes))
}

// The trap: a short word one letter from a listed one is not the listed one.
ok('a short word is not matched loosely', !isListed('as', list))
ok('nor is another short word', !isListed('ash', list))
ok('but the short word itself still is', isListed('ass', list))

// The other trap: a listed word inside a longer, innocent one.
ok('a word that merely contains a listed one is left', !isListed('crumbling', list))
ok('and the listed word alone is caught', isListed('crumb', list))

// --------------------------------------------------------------- making cuts

const heard = (text, from, to) => ({ text, from, to })

{
  const cuts = cutsFor([heard('sing', 0, 0.5), heard('badword', 1, 1.4), heard('along', 2, 2.4)], list)
  eq('only the listed word is cut', cuts.length, 1)
  eq('with air before it', +cuts[0].from.toFixed(3), +(1 - CUT_PAD_SEC).toFixed(3))
  eq('and after', +cuts[0].to.toFixed(3), +(1.4 + CUT_PAD_SEC).toFixed(3))
  eq('and it says what it heard', cuts[0].words.join(), 'badword')
}

{
  const cuts = cutsFor([heard('badword', 1, 1.2), heard('rudeness', 1.25, 1.5)], list)
  eq('two together become one cut', cuts.length, 1)
  eq('covering both', cuts[0].words.length, 2)
  ok('running from the first to the last', cuts[0].from < 1 && cuts[0].to > 1.5)
}

{
  const far = cutsFor([heard('badword', 1, 1.2), heard('rudeness', 8, 8.3)], list)
  eq('two far apart stay separate', far.length, 2)
}

{
  const cuts = cutsFor([heard('badword', 0.01, 0.2)], list)
  ok('a cut never starts before the track does', cuts[0].from >= 0)
}

{
  const cuts = cutsFor([heard('badword', NaN, 1), heard('rudeness', 2, 2.2)], list)
  eq('a word with no time is skipped', cuts.length, 1)
  eq('leaving the ones that have times', cuts[0].words.join(), 'rudeness')
}

{
  const backwards = cutsFor([heard('rudeness', 5, 5.2), heard('badword', 1, 1.2)], list)
  eq('cuts come back in order', backwards.map((c) => c.words[0]).join(), 'badword,rudeness')
}

eq('nothing heard means nothing cut', cutsFor([], list).length, 0)
eq('a clean vocal is left alone', cutsFor([heard('lovely', 0, 1)], list).length, 0)

// The real list is what ships, so it has to at least load and be sane.
{
  const real = prepareList((await import('./.build/badWords.mjs')).BAD_WORDS)
  ok('the shipped list has plenty in it', real.size > 300)
  ok('and holds nothing empty', ![...real].some((w) => w.length < 2))
  ok('an ordinary word is not in it', !isListed('sandwich', real))
  ok('nor another', !isListed('remix', real))
  ok('nor a common one that rhymes with trouble', !isListed('bass', real))
}
