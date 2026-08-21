import { useEffect, useRef, useState } from 'react'
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement
} from 'react'
import type { DeckId, HotCue } from '@shared/types'
import type { ChannelEq, EqMode } from '@shared/eq'
import { CENTRE, eqGainDb, formatDb, formatFilter, isFlat, trimGainDb } from '@shared/eq'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { bpmAt } from '@renderer/core/beatgrid'
import { HOT_CUE_COUNT, HOT_CUE_LABELS } from '@renderer/core/constants'
import { clamp, formatBpm, formatTime } from '@renderer/core/format'
import { useRaf, useTextRef } from '@renderer/hooks/useRaf'
import { useDecks } from '@renderer/state/useDecks'
import { useLibrary } from '@renderer/state/useLibrary'
import { useSettings } from '@renderer/state/useSettings'
import { DetailWaveform } from '@renderer/components/waveform/DetailWaveform'

export interface EditTrackProps {
  deckId: DeckId
}

const EMPTY_TIME = '0:00.0'

/** How long a refused cut explains itself for, in ms. */
const NOTICE_MS = 1800

/** Fallback for a refusal that arrived without a reason. */
const CUT_FAILED = 'Cannot cut here'

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
 * A preview is sounding, but it is not playback: PLAY stays dark and the
 * button only gets a faint green rim, so "something is coming out of this row"
 * is still readable at a glance without the transport claiming to be rolling.
 * The held CUE button or the held pad says which preview it is.
 */
const PREVIEW_HINT = {
  borderColor: 'var(--play)',
  boxShadow: 'inset 0 0 0 1px var(--play-glow)'
} as const

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
const KNOB_TRAVEL_PX = 140

/** Drawn small: five of these plus a button share the width of the pad row. */
const KNOB_SIZE = 22
const KNOB_RADIUS = 8.5
/** Sweep of a rotary control, -135 to +135 degrees, as on the hardware. */
const KNOB_SWEEP = 270

interface EqKnobSpec {
  id: keyof ChannelEq
  /** One or two characters: the strip only has 26px per knob. */
  label: string
  /** Spelled out for the tooltip, where there is room. */
  name: string
}

/**
 * Low to high, left to right.
 *
 * A mixer stacks HI at the top and LOW at the bottom, which is why the mixer
 * strip is in that order — but that is a vertical convention. Laid out
 * horizontally it has to read the way frequency does, low on the left.
 */
const EQ_KNOBS: readonly EqKnobSpec[] = [
  { id: 'trim', label: 'T', name: 'Trim' },
  { id: 'low', label: 'LO', name: 'Low' },
  { id: 'mid', label: 'MID', name: 'Mid' },
  { id: 'high', label: 'HI', name: 'High' },
  { id: 'filter', label: 'F', name: 'Filter' }
]

/** Point on the knob circle. 0 degrees is 12 o'clock, positive is clockwise. */
function polar(radius: number, degrees: number): [number, number] {
  const rad = (degrees * Math.PI) / 180
  const c = KNOB_SIZE / 2
  return [c + radius * Math.sin(rad), c - radius * Math.cos(rad)]
}

function arcPath(radius: number, fromDeg: number, toDeg: number): string {
  const [x0, y0] = polar(radius, fromDeg)
  const [x1, y1] = polar(radius, toDeg)
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0
  const sweep = toDeg >= fromDeg ? 1 : 0
  return `M ${x0} ${y0} A ${radius} ${radius} 0 ${large} ${sweep} ${x1} ${y1}`
}

/**
 * What the knob is doing, in the units the knob is in.
 *
 * The mode only reaches the three bands: it decides how deep a full cut goes,
 * so in isolator mode the bottom of a band reads `KILL` rather than a number.
 */
function knobReadout(id: keyof ChannelEq, value: number, mode: EqMode): string {
  if (id === 'filter') return formatFilter(value)
  return formatDb(id === 'trim' ? trimGainDb(value) : eqGainDb(value, mode))
}

interface EqDrag extends EqKnobSpec {
  pointerId: number
  startY: number
  startValue: number
}

interface ChannelEqProps {
  deckId: DeckId
  disabled: boolean
}

/**
 * Trim, three-band EQ and filter for one row.
 *
 * Its own component so that a knob move re-renders five small SVGs instead of
 * the whole row: the waveform beside it is the expensive neighbour, and a drag
 * writes to the store on every pointer move.
 *
 * Knobs are dragged vertically — up is more — and a double-click puts one back
 * to centre, which is how every mixer plugin behaves. The live value goes in a
 * readout floating above the strip rather than under each knob, because 26px
 * of width cannot hold `-26 dB`.
 */
function ChannelEqStrip({ deckId, disabled }: ChannelEqProps): ReactElement {
  const eq = useDecks((s) => s.decks[deckId].eq)
  // Set in the mixer, but it changes what these knobs read, so the strip has
  // to re-render when it flips.
  const eqMode = useSettings((s) => s.eqMode)
  const [readout, setReadout] = useState<string | null>(null)
  const drag = useRef<EqDrag | null>(null)

  const onKnobDown = (e: ReactPointerEvent<HTMLDivElement>, spec: EqKnobSpec): void => {
    if (disabled || e.button !== 0) return
    // Capture, so a drag that wanders off a 22px knob — most of them — keeps
    // feeding this knob until the button comes up.
    e.currentTarget.setPointerCapture(e.pointerId)
    const startValue = eq[spec.id]
    drag.current = { ...spec, pointerId: e.pointerId, startY: e.clientY, startValue }
    setReadout(`${spec.name} ${knobReadout(spec.id, startValue, eqMode)}`)
  }

  const onKnobMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    const value = clamp(d.startValue + (d.startY - e.clientY) / KNOB_TRAVEL_PX, 0, 1)
    useDecks.getState().setChannelKnob(deckId, d.id, value)
    setReadout(`${d.name} ${knobReadout(d.id, value, eqMode)}`)
  }

  const onKnobUp = (): void => {
    drag.current = null
    setReadout(null)
  }

  const onKnobReset = (spec: EqKnobSpec): void => {
    if (disabled) return
    useDecks.getState().resetChannelKnob(deckId, spec.id)
    setReadout(null)
  }

  const flat = isFlat(eq)

  return (
    <div className="edit-eq">
      {readout !== null ? <span className="edit-note mono">{readout}</span> : null}

      {EQ_KNOBS.map((spec) => {
        const value = eq[spec.id]
        const angle = -KNOB_SWEEP / 2 + clamp(value, 0, 1) * KNOB_SWEEP
        const moved = Math.abs(value - CENTRE) > 0.001
        const [px, py] = polar(KNOB_RADIUS - 2, angle)
        const [ix, iy] = polar(KNOB_RADIUS * 0.3, angle)
        return (
          <div
            key={spec.id}
            className={`edit-knob${moved ? ' is-moved' : ''}${disabled ? ' is-disabled' : ''}`}
            role="slider"
            aria-label={`Deck ${deckId} ${spec.name}`}
            aria-disabled={disabled}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(value * 100)}
            aria-valuetext={knobReadout(spec.id, value, eqMode)}
            title={`${spec.name} ${knobReadout(spec.id, value, eqMode)} — drag to set, double-click for flat`}
            onPointerDown={(e) => onKnobDown(e, spec)}
            onPointerMove={onKnobMove}
            onPointerUp={onKnobUp}
            onPointerCancel={onKnobUp}
            onDoubleClick={() => onKnobReset(spec)}
          >
            <svg
              className="edit-knob__dial"
              width={KNOB_SIZE}
              height={KNOB_SIZE}
              viewBox={`0 0 ${KNOB_SIZE} ${KNOB_SIZE}`}
              aria-hidden="true"
            >
              <circle
                className="edit-knob__body"
                cx={KNOB_SIZE / 2}
                cy={KNOB_SIZE / 2}
                r={KNOB_RADIUS - 2.5}
              />
              <path
                className="edit-knob__track"
                d={arcPath(KNOB_RADIUS, -KNOB_SWEEP / 2, KNOB_SWEEP / 2)}
              />
              {/* Filled out from 12 o'clock: centre is flat on all five, so
                  the arc reads as how far from flat the knob is. */}
              {moved ? (
                <path className="edit-knob__value" d={arcPath(KNOB_RADIUS, 0, angle)} />
              ) : null}
              <line className="edit-knob__pointer" x1={ix} y1={iy} x2={px} y2={py} />
            </svg>
            <span className="edit-knob__label">{spec.label}</span>
          </div>
        )
      })}

      <button
        type="button"
        className={`edit-btn edit-btn--flat${flat ? '' : ' is-lit'}`}
        disabled={disabled || flat}
        onClick={() => useDecks.getState().resetChannelEq(deckId)}
        title="Put every knob on this row back to flat"
      >
        <span>Flat</span>
      </button>
    </div>
  )
}

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
  const playing = useDecks((s) => s.decks[deckId].playing)
  const previewing = useDecks((s) => s.decks[deckId].previewing)
  const track = useLibrary((s) => (trackId ? s.trackById(trackId) : undefined))
  const focused = useSettings((s) => s.focusedDeck === deckId)
  // A boolean, not the knobs themselves: this only has to re-render the row
  // when the channel crosses between flat and not, which is rare.
  const eqOn = useDecks((s) => !isFlat(s.decks[deckId].eq))
  const [cueHeld, setCueHeld] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef(0)
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
  const rolling = playing && !previewing

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

  // A row emptied or unmounted mid-notice must not fire into a dead component.
  useEffect(() => () => window.clearTimeout(noticeTimer.current), [])

  // A control that stops taking pointer events mid-hold — the row emptied, so
  // its buttons went disabled — never sees its own release. Nothing else would
  // ever end that preview, so end it here.
  useEffect(() => {
    if (ready || (heldCue.current === null && heldPad.current === null)) return
    heldCue.current = null
    heldPad.current = null
    setCueHeld(false)
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

  // A cut on a clip boundary or in a gap is an ordinary thing to ask for by
  // accident, so `cutAtPlayhead` refuses with a reason rather than throwing,
  // and the row shows it for a moment instead of looking broken.
  const onCut = (): void => {
    const result = useDecks.getState().cutAtPlayhead(deckId)
    window.clearTimeout(noticeTimer.current)
    if (result.ok) {
      setNotice(null)
      return
    }
    setNotice(result.reason ?? CUT_FAILED)
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS)
  }

  const cues = track?.hotCues ?? []
  const title = track?.title ?? (status === 'loading' ? 'Loading' : 'Empty')
  const artist = track?.artist ?? ''

  const onCueDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    // Capture, so the release still lands here if the pointer slides off the
    // button mid-preview; letting go anywhere must stop the preview.
    e.currentTarget.setPointerCapture(e.pointerId)
    heldCue.current = e.pointerId
    setCueHeld(true)
    useDecks.getState().cuePress(deckId)
  }

  // pointerup, pointercancel and lostpointercapture all mean the hold is over.
  // Capture puts the first two on this button wherever the pointer has gone;
  // the third catches a capture torn away without either. Whichever arrives
  // first clears the ref, so the rest are no-ops.
  const onCueEnd = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (heldCue.current !== e.pointerId) return
    heldCue.current = null
    setCueHeld(false)
    useDecks.getState().cueRelease(deckId)
  }

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
          <DetailWaveform deckId={deckId} selectClips />
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
            className={`edit-btn edit-btn--play${rolling ? ' is-lit' : ''}${
              previewing ? ' is-previewing' : ''
            }`}
            style={previewing ? PREVIEW_HINT : undefined}
            disabled={!ready}
            onClick={() => useDecks.getState().togglePlay(deckId)}
            title={previewing ? 'Play: keep playing from here (Space)' : 'Play / pause (Space)'}
          >
            <svg className="edit-btn__icon" viewBox="0 0 12 12" aria-hidden="true">
              {rolling ? <path d="M2 1h3v10H2zM7 1h3v10H7z" /> : <path d="M2.5 1L10.5 6L2.5 11z" />}
            </svg>
            <span>{rolling ? 'Pause' : 'Play'}</span>
          </button>

          <button
            type="button"
            className={`edit-btn edit-btn--cue${cueHeld ? ' is-lit' : ''}`}
            disabled={!ready}
            onPointerDown={onCueDown}
            onPointerUp={onCueEnd}
            onPointerCancel={onCueEnd}
            onLostPointerCapture={onCueEnd}
            title="Cue: back to cue while playing, hold to preview from the cue point, or set it here (C)"
          >
            <svg className="edit-btn__icon" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M1 1h2v10H1zM4.5 6L11 1.5v9z" />
            </svg>
            <span>Cue</span>
          </button>

          <button
            type="button"
            className="edit-btn edit-btn--cut"
            disabled={!ready}
            onClick={onCut}
            title="Cut the track in two at the playhead (Ctrl+E)"
          >
            <span>Cut</span>
            <span className="edit-btn__key">Ctrl+E</span>
          </button>

          {notice !== null ? <span className="edit-note">{notice}</span> : null}
        </div>

        <ChannelEqStrip deckId={deckId} disabled={!ready} />

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
