import type { ReactElement } from 'react'
import { DECK_IDS } from '@shared/types'
import { EditTrack } from '@renderer/components/edit/EditTrack'
import './edit.css'

/**
 * The editing view: the four decks stacked as rows, for building an edit.
 *
 * Every row is a full deck, not a preview — the same store, the same engine,
 * the same key map. Stacking them is what makes an edit readable: four
 * playheads at the same horizontal centre, so the same pixel is "now" on all
 * of them.
 *
 * Exactly one row is focused, and the unshifted keys act on it. `Tab` and
 * `Shift+Tab` walk the four; clicking a row focuses it. The ring itself lives
 * in `useSettings`, so this view holds no state of its own.
 */
export function EditView(): ReactElement {
  return (
    <div className="edit-view">
      {DECK_IDS.map((id) => (
        <EditTrack key={id} deckId={id} />
      ))}
    </div>
  )
}

export default EditView
