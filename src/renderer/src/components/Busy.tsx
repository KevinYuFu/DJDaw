import type { ReactElement } from 'react'
import { DECK_IDS } from '@shared/types'
import { useDecks } from '@renderer/state/useDecks'
import { useEditV2 } from '@renderer/state/useEditV2'

/**
 * That something is happening, along the bottom of the window.
 *
 * Deliberately quiet: a thin bar in the middle of the bottom edge, the way
 * most applications say they are busy. It is there to be found when something
 * feels slow, not to announce itself.
 */
export function Busy(): ReactElement | null {
  const loading = useDecks((s) => DECK_IDS.some((id) => s.decks[id].status === 'loading'))
  const warping = useEditV2((s) => Object.keys(s.warping).length > 0)
  if (!loading && !warping) return null
  return (
    <div className="busy" role="status" aria-label={warping ? 'Warping' : 'Loading'}>
      <div className="busy__bar" />
    </div>
  )
}
