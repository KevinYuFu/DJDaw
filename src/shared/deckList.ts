import type { DeckId } from './types'

/** Name a set of decks for a sentence: "deck A", "decks A and B", "decks A, B and C". */
export function describeDecks(ids: readonly DeckId[]): string {
  if (ids.length === 0) return ''
  const word = ids.length === 1 ? 'deck' : 'decks'
  if (ids.length === 1) return `${word} ${ids[0]}`
  const head = ids.slice(0, -1).join(', ')
  return `${word} ${head} and ${ids[ids.length - 1]}`
}
