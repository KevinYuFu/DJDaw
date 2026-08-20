import { useEffect, useState } from 'react'
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement
} from 'react'
import type { DeckId, HotCue } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { bpmAt } from '@renderer/core/beatgrid'
import { HOT_CUE_COUNT, HOT_CUE_LABELS } from '@renderer/core/constants'
import { formatBpm, formatTime } from '@renderer/core/format'
import { useRaf, useTextRef } from '@renderer/hooks/useRaf'
import { useDecks } from '@renderer/state/useDecks'
import { useLibrary } from '@renderer/state/useLibrary'
import { useSettings } from '@renderer/state/useSettings'
import { DetailWaveform } from '@renderer/components/waveform/DetailWaveform'

export interface EditTrackProps {
  deckId: DeckId
}

const EMPTY_TIME = '0:00.0'

const PAD_INDICES = Array.from({ length: HOT_CUE_COUNT }, (_, i) => i)

/**
 * Buttons that keep focus swallow the Space shortcut, so the row hands it
 * straight back. Preventing the mousedown default stops the DOM focus without
 * touching the click, or the pointerdown that aims the keyboard at this row.
 */
function preventFocus(e: ReactMouseEvent<HTMLElement>): void {
  e.preventDefault()
}

/**
 * A hot cue colour at reduced opacity, so a set pad reads as a cue marker
 * rather than as a lit button. Same treatment the deck's pads get.
 */
function tint(hex: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/**
 * One track of the editing view: a deck squeezed into a single row.
 *
 * It is the same deck underneath — every control calls the store the CDJ-style
 * deck calls, so `Q` / `W`, the number pads and the transport behave
 * identically here. Only the chrome is smaller, because four of these have to
 * fit where two full decks did.
 *
 * The clocks and the live BPM are written straight into their DOM nodes from a
 * rAF loop, as the deck header's are: four rows re-rendering sixty times a
 * second would cost more than everything else on screen.
 */
export function EditTrack({ deckId }: EditTrackProps): ReactElement {
  const status = useDecks((s) => s.decks[deckId].status)
  const trackId = useDecks((s) => s.decks[deckId].trackId)
  const playing = useDecks((s) => s.decks[deckId].playing)
  const track = useLibrary((s) => (trackId ? s.trackById(trackId) : undefined))
  const focused = useSettings((s) => s.focusedDeck === deckId)
  const [cueHeld, setCueHeld] = useState(false)

  const [bpmRef, setBpm] = useTextRef<HTMLSpanElement>()
  const [elapsedRef, setElapsed] = useTextRef<HTMLSpanElement>()
  const [remainingRef, setRemaining] = useTextRef<HTMLSpanElement>()

  const ready = status === 'ready'
  // `deck()` throws until the engine has initialised, which `ready` implies.
  const deck = ready ? AudioEngine.shared().deck(deckId) : null

  useRaf(() => {
    if (!deck) return
    // Read the stores here rather than closing over them, so a grid nudge or a
    // tempo move lands on the next frame without restarting the loop.
    const state = useDecks.getState().decks[deckId]
    const current = state.trackId ? useLibrary.getState().trackById(state.trackId) : undefined
    const grid = current?.grid ?? null
    const pos = deck.positionSeconds()
    const duration = deck.durationSec || current?.durationSec || 0

    setElapsed(formatTime(pos))
    setRemaining(formatTime(pos - duration))
    setBpm(formatBpm(grid ? bpmAt(grid, pos) * (1 + state.pitchPercent / 100) : null))
  }, deck !== null)

  // An emptied row keeps whatever the last frame wrote unless it is cleared.
  useEffect(() => {
    if (deck) return
    setElapsed(EMPTY_TIME)
    setRemaining(`-${EMPTY_TIME}`)
    setBpm(formatBpm(null))
  }, [deck, setBpm, setElapsed, setRemaining])

  const cues = track?.hotCues ?? []
  const title = track?.title ?? (status === 'loading' ? 'Loading' : 'Empty')
  const artist = track?.artist ?? ''

  const onCueDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    // Capture, so the release still lands here if the pointer slides off the
    // button mid-preview; letting go anywhere must stop the preview.
    e.currentTarget.setPointerCapture(e.pointerId)
    setCueHeld(true)
    useDecks.getState().cuePress(deckId)
  }

  const onCueUp = (): void => {
    setCueHeld(false)
    useDecks.getState().cueRelease(deckId)
  }

  const onPadDown = (
    e: ReactPointerEvent<HTMLButtonElement>,
    index: number,
    cue: HotCue | undefined
  ): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    if (e.shiftKey) {
      if (cue) useDecks.getState().deleteHotCue(deckId, index)
      return
    }
    useDecks.getState().triggerHotCue(deckId, index)
  }

  return (
    <section
      className={`edit-track${focused ? ' is-focused' : ''}`}
      data-deck={deckId}
      // Touching a row aims the unshifted keyboard shortcuts at it, the way
      // reaching for the hardware does.
      onPointerDown={() => useSettings.getState().setFocusedDeck(deckId)}
    >
      <div className="edit-track__edge" />

      <div className="edit-track__info">
        <div className="edit-track__id">
          <span className="edit-track__badge">{deckId}</span>
          {track?.artwork ? (
            <img className="edit-track__art" src={track.artwork} alt="" draggable={false} />
          ) : (
            <span className="edit-track__art is-empty" />
          )}
          <span className="edit-track__titles">
            <span className="edit-track__title" title={title}>
              {title}
            </span>
            <span className="edit-track__artist" title={artist}>
              {artist}
            </span>
          </span>
        </div>

        <div className="edit-track__stats">
          <span className="edit-stat edit-stat--bpm">
            <span className="label">BPM</span>
            <span className="edit-stat__value mono" ref={bpmRef}>
              {formatBpm(null)}
            </span>
          </span>
          <span className="edit-stat">
            <span className="label">Key</span>
            <span className="edit-stat__value mono">{track?.key ?? '--'}</span>
          </span>
          <span className="edit-stat edit-stat--time">
            <span className="edit-stat__value mono" ref={elapsedRef}>
              {EMPTY_TIME}
            </span>
            <span className="edit-stat__sub mono" ref={remainingRef}>
              {`-${EMPTY_TIME}`}
            </span>
          </span>
        </div>
      </div>

      <div className="edit-track__wave">
        {status === 'ready' ? (
          <DetailWaveform deckId={deckId} />
        ) : (
          <div className="edit-track__empty">
            {status === 'loading' ? (
              <span>Loading the track</span>
            ) : (
              <>
                <span>Drop a track here</span>
                <span>
                  or press <kbd>A</kbd> to load the selected one
                </span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="edit-track__controls" onMouseDown={preventFocus}>
        <div className="edit-transport">
          <button
            type="button"
            className={`edit-btn edit-btn--play${playing ? ' is-lit' : ''}`}
            disabled={!ready}
            onClick={() => useDecks.getState().togglePlay(deckId)}
            title="Play / pause (Space)"
          >
            <svg className="edit-btn__icon" viewBox="0 0 12 12" aria-hidden="true">
              {playing ? <path d="M2 1h3v10H2zM7 1h3v10H7z" /> : <path d="M2.5 1L10.5 6L2.5 11z" />}
            </svg>
            <span>{playing ? 'Pause' : 'Play'}</span>
          </button>

          <button
            type="button"
            className={`edit-btn edit-btn--cue${cueHeld ? ' is-lit' : ''}`}
            disabled={!ready}
            onPointerDown={onCueDown}
            onPointerUp={onCueUp}
            onPointerCancel={onCueUp}
            title="Cue: back to cue while playing, hold to preview from the cue point, or set it here (C)"
          >
            <svg className="edit-btn__icon" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M1 1h2v10H1zM4.5 6L11 1.5v9z" />
            </svg>
            <span>Cue</span>
          </button>
        </div>

        <div className="edit-pads">
          {PAD_INDICES.map((index) => {
            const cue = cues.find((c) => c.index === index)
            const label = HOT_CUE_LABELS[index]
            return (
              <button
                type="button"
                key={index}
                className={`edit-pad${cue ? ' is-set' : ''}`}
                style={
                  cue
                    ? { background: tint(cue.color, 0.3), borderColor: tint(cue.color, 0.9) }
                    : undefined
                }
                disabled={!ready}
                onPointerDown={(e) => onPadDown(e, index, cue)}
                onPointerUp={() => useDecks.getState().releaseHotCue(deckId, index)}
                onPointerCancel={() => useDecks.getState().releaseHotCue(deckId, index)}
                title={
                  cue
                    ? `Hot cue ${label} at ${formatTime(cue.time)} — hold to preview, shift-click to delete (${index + 1})`
                    : `Set hot cue ${label} here (${index + 1})`
                }
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}

export default EditTrack
