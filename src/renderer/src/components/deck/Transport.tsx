import { useEffect, useRef, useState } from 'react'
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

/**
 * A preview is sounding, but it is not playback: PLAY stays dark and the deck
 * only gets a faint green rim, so "something is coming out of this deck" is
 * still readable at a glance without the transport claiming to be rolling.
 * The held CUE button or the held pad says which preview it is.
 */
const PREVIEW_HINT = {
  borderColor: 'var(--play)',
  boxShadow: 'inset 0 0 0 1px var(--play-glow)'
} as const

/** PLAY and CUE, shaped and lit like the pair under a CDJ's platter. */
export function Transport({ deckId }: TransportProps): ReactElement {
  const deck = useDecks((s) => s.decks[deckId])
  const [cueHeld, setCueHeld] = useState(false)
  // The pointer holding CUE down. Only that pointer may release it, so a
  // second pointer cannot end a preview it never started.
  const held = useRef<number | null>(null)
  const ready = deck.status === 'ready'
  // A held preview runs the deck without being playback, so the transport
  // reads as stopped: PLAY unlit, and still offering to play. Pressing it
  // there latches the preview into real playback, which is what the store's
  // togglePlay already does.
  const rolling = deck.playing && !deck.previewing

  // A CUE button that stops taking pointer events mid-hold — the deck
  // ejected, so it went disabled — never sees its own release, and neither
  // does one unmounted mid-hold. Either way the preview would run on with
  // nothing left to end it.
  useEffect(() => {
    if (ready || held.current === null) return
    held.current = null
    setCueHeld(false)
    useDecks.getState().endPreview(deckId)
  }, [ready, deckId])

  useEffect(
    () => () => {
      if (held.current === null) return
      held.current = null
      useDecks.getState().endPreview(deckId)
    },
    [deckId]
  )

  const onCueDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    // Capture, so the release still lands here if the pointer slides off the
    // button mid-preview; letting go anywhere must stop the preview.
    e.currentTarget.setPointerCapture(e.pointerId)
    held.current = e.pointerId
    setCueHeld(true)
    useDecks.getState().cuePress(deckId)
  }

  // pointerup, pointercancel and lostpointercapture all mean the hold is over.
  // Capture puts the first two on this button wherever the pointer has gone;
  // the third catches a capture torn away without either. Whichever arrives
  // first clears the ref, so the rest are no-ops.
  const onCueEnd = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (held.current !== e.pointerId) return
    held.current = null
    setCueHeld(false)
    useDecks.getState().cueRelease(deckId)
  }

  return (
    <div className="transport" onMouseDown={preventFocus}>
      <button
        type="button"
        className={`transport-btn transport-play${rolling ? ' is-lit' : ''}${
          deck.previewing ? ' is-previewing' : ''
        }`}
        style={deck.previewing ? PREVIEW_HINT : undefined}
        disabled={!ready}
        onClick={() => useDecks.getState().togglePlay(deckId)}
        title={deck.previewing ? 'Play: keep playing from here (Space)' : 'Play / pause (Space)'}
      >
        <svg className="transport-icon" viewBox="0 0 12 12" aria-hidden="true">
          {rolling ? <path d="M2 1h3v10H2zM7 1h3v10H7z" /> : <path d="M2.5 1L10.5 6L2.5 11z" />}
        </svg>
        <span className="transport-label">{rolling ? 'Pause' : 'Play'}</span>
      </button>

      <button
        type="button"
        className={`transport-btn transport-cue${cueHeld ? ' is-lit' : ''}`}
        disabled={!ready}
        onPointerDown={onCueDown}
        onPointerUp={onCueEnd}
        onPointerCancel={onCueEnd}
        onLostPointerCapture={onCueEnd}
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
