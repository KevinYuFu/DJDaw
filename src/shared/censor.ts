/**
 * Finding words to take out of a vocal.
 *
 * A transcription hands back words with the moment each was sung. Anything
 * matching the list becomes a stretch of time to remove from the vocal, with a
 * little air either side so a consonant is not left hanging.
 *
 * Matching is deliberately loose. A word sung, slurred and put through a
 * transcriber that was trained on speech comes back spelt all sorts of ways,
 * and for a censor a word missed is worse than a word caught that should not
 * have been — one is heard by a room, the other is put back with one click.
 */

/** A word the transcription heard, and when. Seconds. */
export interface HeardWord {
  text: string
  from: number
  to: number
}

/** A stretch of the vocal to take out. Seconds. */
export interface Cut {
  from: number
  to: number
  /** What was heard there, so it can be shown and undone. */
  words: string[]
}

/** Air left either side of a word, so its edges are not left audible. */
export const CUT_PAD_SEC = 0.06

/** Cuts closer together than this are run into one. */
export const CUT_JOIN_SEC = 0.12

/** Below this length a word is only matched exactly, never loosely. */
const FUZZY_FLOOR = 5

/**
 * Characters people swap for letters, to write a word without writing it.
 *
 * Only ones that are not ordinary punctuation. An exclamation mark stands in
 * for an i often enough on the internet, but a transcription ends half its
 * words with one, and turning those into letters mangles every one of them.
 */
const LOOKALIKES: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  '$': 's'
}

/**
 * A word reduced to what it sounds like.
 *
 * Punctuation and case go, lookalike characters become the letters they stand
 * in for, and a letter held down for three or more comes back to two.
 *
 * Two and not one: plenty of words are spelt with a double letter, and folding
 * those down turns them into different, innocent words. Anything left over
 * after that is close enough for {@link isListed} to catch by distance.
 */
export function plainly(word: string): string {
  const swapped = word
    .toLowerCase()
    .split('')
    .map((c) => (c in LOOKALIKES ? LOOKALIKES[c] : c))
    .join('')
  const letters = swapped.replace(/[^a-z]/g, '')
  return letters.replace(/(.)\1{2,}/g, '$1$1')
}

/** How many single-letter changes turn one word into the other, up to `most`. */
export function distance(a: string, b: string, most = 2): number {
  if (Math.abs(a.length - b.length) > most) return most + 1
  let previous = new Array(b.length + 1).fill(0).map((_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost)
      best = Math.min(best, row[j])
    }
    if (best > most) return most + 1
    previous = row
  }
  return previous[b.length]
}

/** Everything the list holds, reduced the same way a heard word is. */
export function prepareList(words: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const w of words) {
    const plain = plainly(w)
    if (plain.length > 1) out.add(plain)
  }
  return out
}

/**
 * Whether a word is one the censor is listening for.
 *
 * A word has to match outright, or be one letter away from something on the
 * list and start with the same letter.
 *
 * Both guards earn their place. Short words match outright only: at three or
 * four letters, a letter of slack catches half the dictionary. And the letter
 * a word starts on has to hold, or `night` pulls in `right` and `might` — a
 * transcriber mishears the middle of a sung word far more often than its
 * opening, so this costs little and stops a great deal.
 */
export function isListed(word: string, list: ReadonlySet<string>): boolean {
  const plain = plainly(word)
  if (plain.length < 2) return false
  if (list.has(plain)) return true
  if (plain.length < FUZZY_FLOOR) return false
  for (const entry of list) {
    if (entry.length < FUZZY_FLOOR) continue
    if (entry[0] !== plain[0]) continue
    if (Math.abs(entry.length - plain.length) > 1) continue
    if (distance(plain, entry, 1) <= 1) return true
  }
  return false
}

/**
 * The stretches of a vocal to remove, in order and never overlapping.
 *
 * Words are padded, then anything left touching is run together, so two swears
 * in a row come out as one clean cut rather than two with a sliver between.
 */
export function cutsFor(
  heard: readonly HeardWord[],
  list: ReadonlySet<string>,
  pad = CUT_PAD_SEC
): Cut[] {
  const hits: Cut[] = []
  for (const word of heard) {
    if (!Number.isFinite(word.from) || !Number.isFinite(word.to)) continue
    if (!isListed(word.text, list)) continue
    const from = Math.max(0, word.from - pad)
    const to = Math.max(from, word.to + pad)
    hits.push({ from, to, words: [word.text.trim()] })
  }
  hits.sort((a, b) => a.from - b.from)

  const merged: Cut[] = []
  for (const hit of hits) {
    const last = merged[merged.length - 1]
    if (last && hit.from - last.to <= CUT_JOIN_SEC) {
      last.to = Math.max(last.to, hit.to)
      last.words.push(...hit.words)
      continue
    }
    merged.push({ ...hit, words: [...hit.words] })
  }
  return merged
}
