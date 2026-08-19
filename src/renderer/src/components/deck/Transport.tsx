import { useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { DeckId } from '@shared/types'
import { useDecks } from '@renderer/state/useDecks'

export interface TransportProps {
  deckId: DeckId
}

/**
 * Buttons that keep focus swallow the Space shortcut, so the transport gives
 * it straight back. Preventing the mousedown default stops the focus without
 * touching the click that follows.
 */
function preventFocus(e: ReactMouseEvent<HTMLElement>): void {
  e.preventDefault()
}

/** PLAY and CUE, shaped and lit like the pair under a CDJ's platter. */
export function Transport({ deckId }: TransportProps): ReactElement {
  const deck = useDecks((s) => s.decks[deckId])
  const [cueHeld, setCueHeld] = useState(false)
  const ready = deck.status === 'ready'
  const playing = deck.playing

  const onCueDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    // Capture so the release still lands here if the pointer slides off the
    // button mid-preview; letting go anywhere must stop the preview.
    e.currentTarget.setPointerCapture(e.pointerId)
    setCueHeld(true)
    useDecks.getState().cuePress(deckId)
  }

  const onCueUp = (): void => {
    setCueHeld(false)
    useDecks.getState().cueRelease(deckId)
  }

  return (
    <div className="transport" onMouseDown={preventFocus}>
      <button
        type="button"
        className={`transport-btn transport-play${playing ? ' is-lit' : ''}`}
        disabled={!ready}
        onClick={() => useDecks.getState().togglePlay(deckId)}
        title="Play / pause (Space)"
      >
        <svg className="transport-icon" viewBox="0 0 12 12" aria-hidden="true">
          {playing ? <path d="M2 1h3v10H2zM7 1h3v10H7z" /> : <path d="M2.5 1L10.5 6L2.5 11z" />}
        </svg>
        <span className="transport-label">{playing ? 'Pause' : 'Play'}</span>
      </button>

      <button
        type="button"
        className={`transport-btn transport-cue${cueHeld ? ' is-lit' : ''}`}
        disabled={!ready}
        onPointerDown={onCueDown}
        onPointerUp={onCueUp}
        onPointerCancel={onCueUp}
        title="Cue: back to cue while playing, hold to preview from the cue point, or set it here (C)"
      >
        <svg className="transport-icon" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M1 1h2v10H1zM4.5 6L11 1.5v9z" />
        </svg>
        <span className="transport-label">Cue</span>
      </button>
    </div>
  )
}
