import type { ReactElement } from 'react'
import { MAX_TRACKS } from '@shared/arrangement'
import { useArrangement } from '@renderer/state/useArrangement'
import { ArrangementTrackRow } from './ArrangementTrackRow'
import './arrangement.css'

/**
 * Clips laid out on one timeline, the way a DAW arranges them.
 *
 * Its tracks are its own: nothing here is a deck, and switching to another
 * view carries nothing across. Every track shares one grid, so zooming moves
 * all of them together and a moment on one lane is the same moment on the next.
 */
export function ArrangementView(): ReactElement {
  const trackIds = useArrangement((s) => s.trackIds)
  const addTrack = useArrangement((s) => s.addTrack)

  return (
    <div className="arrangement">
      <header className="arrangement__bar">
        <button
          type="button"
          className="arrangement__add"
          disabled={trackIds.length >= MAX_TRACKS}
          title={
            trackIds.length >= MAX_TRACKS ? `${MAX_TRACKS} tracks is the most` : 'Add a track'
          }
          onClick={() => addTrack()}
        >
          + TRACK
        </button>
      </header>

      <div className="arrangement__lanes">
        {trackIds.map((id) => (
          <ArrangementTrackRow key={id} trackId={id} />
        ))}
      </div>
    </div>
  )
}
