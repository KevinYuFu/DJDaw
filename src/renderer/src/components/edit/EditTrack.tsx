import { useEffect, useRef } from 'react'
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement
} from 'react'
import type { DeckId, HotCue } from '@shared/types'
import { isFlat } from '@shared/eq'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { bpmAt } from '@renderer/core/beatgrid'
import { HOT_CUE_COUNT, HOT_CUE_LABELS } from '@renderer/core/constants'
import { formatBpm, formatTime } from '@renderer/core/format'
import { useRaf, useTextRef } from '@renderer/hooks/useRaf'
import { useDecks } from '@renderer/state/useDecks'
import { useLibrary } from '@renderer/state/useLibrary'
import { useSettings } from '@renderer/state/useSettings'
import { ChannelEqStrip, ChannelFader } from '@renderer/components/channel/ChannelControls'
import { DetailWaveform } from '@renderer/components/waveform/DetailWaveform'
import { OverviewWaveform } from '@renderer/components/waveform/OverviewWaveform'

export interface EditTrackProps {
  deckId: DeckId
}

const EMPTY_TIME = '0:00.0'

const PAD_INDICES = Array.from({ length: HOT_CUE_COUNT }, (_, i) => i)

/**
 * The pointer holding a pad down, and which pad it is holding.
 *
 * A press and its release are one gesture, so only the pointer that started it
 * may end it: a second finger landing on another pad must not release the
 * first one's preview, and a stray release from a pointer that never pressed
 * must not release anything at all.
 */
interface HeldPad {
  pointerId: number
  index: number
}


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

/* ------------------------------------------------------------- channel EQ */

/** Pointer travel, in px, for the whole sweep of a knob. */
/**
 * One track of the editing view: a deck squeezed into a single row.
 *
 * It is the same deck underneath — every control calls the store the CDJ-style
 * deck calls, so `Q` / `W`, the number pads, the transport and the channel EQ
 * behave identically here. Only the chrome is smaller, because four of these have to
 * fit where two full decks did.
 *
 * The clocks and the live BPM are written straight into their DOM nodes from a
 * rAF loop, as the deck header's are: four rows re-rendering sixty times a
 * second would cost more than everything else on screen.
 */
export function EditTrack({ deckId }: EditTrackProps): ReactElement {
  const status = useDecks((s) => s.decks[deckId].status)
  const trackId = useDecks((s) => s.decks[deckId].trackId)
  const track = useLibrary((s) => (trackId ? s.trackById(trackId) : undefined))
  const focused = useSettings((s) => s.focusedDeck === deckId)
  // A boolean, not the knobs themselves: this only has to re-render the row
  // when the channel crosses between flat and not, which is rare.
  const eq = useDecks((s) => s.decks[deckId].eq)
  const fader = useDecks((s) => s.decks[deckId].fader)
  const eqOn = !isFlat(eq)
  // The pointers holding CUE and a pad down. Only the pointer that started a
  // hold may end it, so a second pointer cannot release someone else's press.
  const heldCue = useRef<number | null>(null)
  const heldPad = useRef<HeldPad | null>(null)

  const [bpmRef, setBpm] = useTextRef<HTMLSpanElement>()
  const [elapsedRef, setElapsed] = useTextRef<HTMLSpanElement>()
  const [remainingRef, setRemaining] = useTextRef<HTMLSpanElement>()

  const ready = status === 'ready'
  // `deck()` throws until the engine has initialised, which `ready` implies.
  const deck = ready ? AudioEngine.shared().deck(deckId) : null
  // A held preview runs the deck without being playback, so the transport
  // reads as stopped: PLAY unlit, and still offering to play. Pressing it
  // there latches the preview into real playback, which is what the store's
  // togglePlay already does.

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


  // A control that stops taking pointer events mid-hold — the row emptied, so
  // its buttons went disabled — never sees its own release. Nothing else would
  // ever end that preview, so end it here.
  useEffect(() => {
    if (ready || heldPad.current === null) return
    heldPad.current = null
    useDecks.getState().endPreview(deckId)
  }, [ready, deckId])

  // Same for a row unmounted mid-hold: an unmounted element never sees its own
  // pointerup, and a stuck preview outlives the component that started it.
  useEffect(
    () => () => {
      if (heldCue.current === null && heldPad.current === null) return
      heldCue.current = null
      heldPad.current = null
      useDecks.getState().endPreview(deckId)
    },
    [deckId]
  )

  const cues = track?.hotCues ?? []
  const title = track?.title ?? (status === 'loading' ? 'Loading' : 'Empty')
  const artist = track?.artist ?? ''


  // pointerup, pointercancel and lostpointercapture all mean the hold is over.
  // Capture puts the first two on this button wherever the pointer has gone;
  // the third catches a capture torn away without either. Whichever arrives
  // first clears the ref, so the rest are no-ops.

  const onPadDown = (
    e: ReactPointerEvent<HTMLButtonElement>,
    index: number,
    cue: HotCue | undefined
  ): void => {
    if (e.button !== 0) return
    if (e.shiftKey) {
      // A delete is over the instant it happens; there is no hold to track.
      if (cue) useDecks.getState().deleteHotCue(deckId, index)
      return
    }
    // Capture before the trigger. Without it the release only arrives while
    // the pointer is still over the pad, and a release a few pixels away
    // leaves the preview running until the track hits its end.
    e.currentTarget.setPointerCapture(e.pointerId)
    heldPad.current = { pointerId: e.pointerId, index }
    useDecks.getState().triggerHotCue(deckId, index)
  }

  /** The pad counterpart of {@link onCueEnd}, released by cue index. */
  const onPadEnd = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const hold = heldPad.current
    if (!hold || hold.pointerId !== e.pointerId) return
    heldPad.current = null
    useDecks.getState().releaseHotCue(deckId, hold.index)
  }

  return (
    <section
      className={`edit-track${focused ? ' is-focused' : ''}${eqOn ? ' is-eq-on' : ''}`}
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
          <>
            {/* The MACRO view: the whole row at once, which is the only place
                a piece can be dragged somewhere else in the track — the MICRO
                view below shows a few seconds and cannot see where it is
                going. */}
            <OverviewWaveform deckId={deckId} draggableClips />
            <DetailWaveform deckId={deckId} selectClips />
          </>
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

      <ChannelFader
        label={`Deck ${deckId}`}
        position={fader}
        disabled={!ready}
        onChange={(position) => useDecks.getState().setFader(deckId, position)}
      />

      <div className="edit-track__controls" onMouseDown={preventFocus}>

        <ChannelEqStrip
          label={`Deck ${deckId}`}
          eq={eq}
          disabled={!ready}
          onKnob={(id, value) => useDecks.getState().setChannelKnob(deckId, id, value)}
          onResetKnob={(id) => useDecks.getState().resetChannelKnob(deckId, id)}
          onResetAll={() => useDecks.getState().resetChannelEq(deckId)}
        />

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
                onPointerUp={onPadEnd}
                onPointerCancel={onPadEnd}
                onLostPointerCapture={onPadEnd}
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
