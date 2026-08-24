import type { ReactElement } from 'react'
import { DECK_IDS } from '@shared/types'
import { useDecks } from '@renderer/state/useDecks'

/**
 * That something is happening, along the bottom of the window.
 *
 * Deliberately quiet: a thin bar in the middle of the bottom edge, the way
 * most applications say they are busy. It is there to be found when something
 * feels slow, not to announce itself.
 */
export function Busy(): ReactElement | null {
  const loading = useDecks((s) => DECK_IDS.some((id) => s.decks[id].status === 'loading'))
  if (!loading) return null
  return (
    <div className="busy" role="status" aria-label="Loading">
      <div className="busy__bar" />
    </div>
  )
}
