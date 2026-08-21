/** Naming the decks a warning is about. */
import { describeDecks } from './.build/deckList.mjs'

const { eq } = globalThis.__t

eq('no decks names nothing', describeDecks([]), '')
eq('one deck is singular', describeDecks(['A']), 'deck A')
eq('two decks read as a pair', describeDecks(['A', 'B']), 'decks A and B')
eq('three decks use a list, not chained ands', describeDecks(['A', 'B', 'C']), 'decks A, B and C')
eq('all four read as a list', describeDecks(['A', 'B', 'C', 'D']), 'decks A, B, C and D')
eq('the edit-only decks are nameable', describeDecks(['C', 'D']), 'decks C and D')
