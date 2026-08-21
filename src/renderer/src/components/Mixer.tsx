import { useCallback, useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement, RefObject } from 'react'
import type { DeckId } from '@shared/types'
import type { ChannelEq, EqMode } from '@shared/eq'
import { CENTRE, eqGainDb, formatDb, formatFilter, trimGainDb } from '@shared/eq'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { useDecks } from '@renderer/state/useDecks'
import { useSettings } from '@renderer/state/useSettings'
import { clamp } from '@renderer/core/format'

/**
 * The centre strip between the decks.
 *
 * Everything here is live. Trim, the three-band EQ and the filter write a 0-1
 * knob position into the deck's `eq` state and the deck's own DSP chain reads
 * it from there; the channel faders and the crossfader multiply into each
 * deck's output gain through the engine.
 */

/**
 * The mixer is a two-channel unit, like the hardware it is modelled on. The
 * engine now carries four decks for the editing view, but only A and B are
 * wired through here, so the channel type stays narrower than `DeckId`.
 */
const DECKS = ['A', 'B'] as const satisfies readonly DeckId[]
type MixerChannel = (typeof DECKS)[number]

/** Cap height/width in px. Shared by the render and the hit maths. */
const FADER_CAP = 14
const CROSSFADER_CAP = 18

interface KnobSpec {
  /** Which knob of the channel this drives. */
  id: keyof ChannelEq
  label: string
  /**
   * The small readout under the knob. Trim and the filter take the mode too
   * and ignore it: only the three bands have a cut floor to choose.
   */
  format(value: number, mode: EqMode): string
}

/**
 * Top to bottom: HI, MID, LOW. Every DJ mixer stacks the bands that way, so a
 * hand that knows the hardware reaches for the right knob without looking.
 * Leave it alone. The editing view lays the same knobs out in a row, and there
 * it runs LO, MID, HI left to right, because a horizontal strip has to read
 * the way frequency does. The two orders disagree on purpose.
 */
const CHANNEL_KNOBS: readonly KnobSpec[] = [
  { id: 'trim', label: 'TRIM', format: (v) => formatDb(trimGainDb(v)) },
  { id: 'high', label: 'HI', format: (v, mode) => formatDb(eqGainDb(v, mode)) },
  { id: 'mid', label: 'MID', format: (v, mode) => formatDb(eqGainDb(v, mode)) },
  { id: 'low', label: 'LOW', format: (v, mode) => formatDb(eqGainDb(v, mode)) },
  { id: 'filter', label: 'FILTER', format: (v) => formatFilter(v) }
]

/**
 * The switch picks between two different circuits, not two settings of one, so
 * the tooltip says what each one sounds like rather than naming the filters.
 * No numbers here: the readout under every knob already shows the dB.
 */
const EQ_MODE_TITLE = [
  'EQ: turn a band down and it drops a lot, but you can still hear it.',
  'ISO: turn a band down and it is gone. Silent.',
  'On a DDJ-FLX10 this is shift+CUE. rekordbox has the same switch in its settings.'
].join('\n')

const KNOB_SIZE = 30
const KNOB_RADIUS = 11
/** Sweep of a rotary control, -135 to +135 degrees, as on the hardware. */
const KNOB_SWEEP = 270
/** Vertical pixels for the full 0-1 travel. About a hardware knob's throw. */
const KNOB_TRAVEL_PX = 140
/** Shift shrinks the same movement by this much, for fine EQ moves. */
const KNOB_FINE_SCALE = 0.25

/** Point on the knob circle. 0 degrees is 12 o'clock, positive is clockwise. */
function polar(radius: number, degrees: number): [number, number] {
  const rad = (degrees * Math.PI) / 180
  const c = KNOB_SIZE / 2
  return [c + radius * Math.sin(rad), c - radius * Math.cos(rad)]
}

function knobAngle(value: number): number {
  return -KNOB_SWEEP / 2 + clamp(value, 0, 1) * KNOB_SWEEP
}

function arcPath(radius: number, fromDeg: number, toDeg: number): string {
  const [x0, y0] = polar(radius, fromDeg)
  const [x1, y1] = polar(radius, toDeg)
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0
  const sweep = toDeg >= fromDeg ? 1 : 0
  return `M ${x0} ${y0} A ${radius} ${radius} 0 ${large} ${sweep} ${x1} ${y1}`
}

interface KnobDrag {
  pointerId: number
  /** The y the last move was measured from. */
  lastY: number
  /**
   * The value carried across moves. Each move steps this running value rather
   * than re-deriving it from the press point, so pressing or releasing Shift
   * part-way through a drag changes the sensitivity without jumping the knob.
   */
  value: number
}

interface KnobProps {
  deck: DeckId
  label: string
  value: number
  readout: string
  onChange(value: number): void
  onReset(): void
}

/**
 * One rotary control. Drag up for more, down for less; Shift is fine control;
 * double-click returns it to centre, which is how a knob gets put back flat in
 * the middle of a mix.
 */
function Knob({ deck, label, value, readout, onChange, onReset }: KnobProps): ReactElement {
  const drag = useRef<KnobDrag | null>(null)
  const angle = knobAngle(value)
  const centre = knobAngle(CENTRE)
  const [px, py] = polar(KNOB_RADIUS - 2, angle)
  const [ix, iy] = polar(KNOB_RADIUS * 0.35, angle)
  const [dx, dy] = polar(KNOB_RADIUS + 1.4, centre)
  const [dx2, dy2] = polar(KNOB_RADIUS + 3.4, centre)

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      drag.current = { pointerId: event.pointerId, lastY: event.clientY, value }
      // Capture so a drag that wanders off a 30px knob keeps tracking.
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [value]
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = drag.current
      if (!state || state.pointerId !== event.pointerId) return
      const scale = event.shiftKey ? KNOB_FINE_SCALE : 1
      const step = ((state.lastY - event.clientY) / KNOB_TRAVEL_PX) * scale
      state.lastY = event.clientY
      state.value = clamp(state.value + step, 0, 1)
      onChange(state.value)
    },
    [onChange]
  )

  /**
   * Also wired to `lostpointercapture`: a pointerup that never arrives would
   * otherwise leave the knob following the cursor for the rest of the set.
   */
  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  return (
    <div
      className="knob"
      role="slider"
      aria-label={`Deck ${deck} ${label}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      aria-valuetext={readout}
      title="Drag up or down. Double-click to centre."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={onReset}
    >
      <svg width={KNOB_SIZE} height={KNOB_SIZE} viewBox={`0 0 ${KNOB_SIZE} ${KNOB_SIZE}`} aria-hidden="true">
        <circle className="knob__body" cx={KNOB_SIZE / 2} cy={KNOB_SIZE / 2} r={KNOB_RADIUS - 2.5} />
        <path className="knob__track" d={arcPath(KNOB_RADIUS, -KNOB_SWEEP / 2, KNOB_SWEEP / 2)} />
        <line className="knob__detent" x1={dx} y1={dy} x2={dx2} y2={dy2} />
        {/* Grown out from 12 o'clock, so centre reads as flat and the arc
            shows cut to the left and boost to the right. */}
        {Math.abs(angle - centre) > 0.5 && (
          <path className="knob__value" d={arcPath(KNOB_RADIUS, centre, angle)} />
        )}
        <line className="knob__pointer" x1={ix} y1={iy} x2={px} y2={py} />
      </svg>
      <span className="knob__readout">{readout}</span>
    </div>
  )
}

interface FaderProps {
  value: number
  onChange(value: number): void
  ariaLabel: string
}

/**
 * A dragged fader. Position is read from the pointer against the track's own
 * box, with the cap's height taken out of the usable travel so the cap centre
 * lands under the cursor at both ends.
 */
function useFaderDrag(
  onChange: (value: number) => void,
  read: (rect: DOMRect, event: { clientX: number; clientY: number }) => number
): {
  ref: RefObject<HTMLDivElement | null>
  onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void
  onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void
  onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void
} {
  const ref = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)

  const apply = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const el = ref.current
      if (!el) return
      onChange(read(el.getBoundingClientRect(), event))
    },
    [onChange, read]
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      dragging.current = true
      // Capture so a fast drag that leaves the 20px-wide track keeps tracking.
      event.currentTarget.setPointerCapture(event.pointerId)
      apply(event)
    },
    [apply]
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragging.current) apply(event)
    },
    [apply]
  )

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  return { ref, onPointerDown, onPointerMove, onPointerUp }
}

function ChannelFader({ value, onChange, ariaLabel }: FaderProps): ReactElement {
  const read = useCallback((rect: DOMRect, event: { clientY: number }) => {
    const travel = rect.height - FADER_CAP
    if (travel <= 0) return 0
    return clamp(1 - (event.clientY - rect.top - FADER_CAP / 2) / travel, 0, 1)
  }, [])
  const drag = useFaderDrag(onChange, read)
  return (
    <div
      className="fader"
      ref={drag.ref}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onPointerCancel={drag.onPointerUp}
    >
      <div className="fader__slot" />
      <div
        className="fader__cap"
        style={{ top: `calc(${FADER_CAP / 2}px + ${1 - value} * (100% - ${FADER_CAP}px))` }}
      />
    </div>
  )
}

function Crossfader({ value, onChange, ariaLabel }: FaderProps): ReactElement {
  const read = useCallback((rect: DOMRect, event: { clientX: number }) => {
    const travel = rect.width - CROSSFADER_CAP
    if (travel <= 0) return 0.5
    return clamp((event.clientX - rect.left - CROSSFADER_CAP / 2) / travel, 0, 1)
  }, [])
  const drag = useFaderDrag(onChange, read)
  return (
    <div
      className="crossfader"
      ref={drag.ref}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onPointerCancel={drag.onPointerUp}
      onDoubleClick={() => onChange(0.5)}
      title="Crossfader — double-click to centre"
    >
      <div className="crossfader__slot" />
      <div className="crossfader__notch" />
      <div
        className="crossfader__cap"
        style={{ left: `calc(${CROSSFADER_CAP / 2}px + ${value} * (100% - ${CROSSFADER_CAP}px))` }}
      />
    </div>
  )
}



export function Mixer(): ReactElement {
  // The store holds these, not the mixer. The editing view has faders for the
  // same decks, and this panel is unmounted while that view is open — kept
  // locally, whichever mounted last would overwrite the other.
  const faderA = useDecks((s) => s.decks.A.fader)
  const faderB = useDecks((s) => s.decks.B.fader)
  const crossfade = useDecks((s) => s.crossfade)
  const setFader = useDecks((s) => s.setFader)
  const setCrossfade = useDecks((s) => s.setCrossfade)
  const eqA = useDecks((s) => s.decks.A.eq)
  const eqB = useDecks((s) => s.decks.B.eq)
  const setChannelKnob = useDecks((s) => s.setChannelKnob)
  const resetChannelKnob = useDecks((s) => s.resetChannelKnob)
  const eqMode = useSettings((s) => s.eqMode)
  const setEqMode = useSettings((s) => s.setEqMode)


  // The store pushes a level as it changes, but a value restored before the
  // engine existed has nothing to push to; re-apply once it is up.
  useEffect(() => {
    void AudioEngine.shared()
      .init()
      .then(() => {
        const s = useDecks.getState()
        s.setCrossfade(s.crossfade)
      })
      .catch(() => {
        // Startup failures are reported by the app shell, not by a fader.
      })
  }, [])


  const eq: Record<MixerChannel, ChannelEq> = { A: eqA, B: eqB }

  return (
    <div className="mixer">
      <div className="mixer__row mixer__row--head">
        {DECKS.map((id) => (
          <span key={id} className="mixer__channel-id" data-deck={id}>
            {id}
          </span>
        ))}
      </div>

      {/* EQ or isolator is one switch for the whole mixer, as it is on the
          hardware, so it sits above the channels rather than inside one. */}
      <div className="mixer__mode" role="group" aria-label="EQ or isolator" title={EQ_MODE_TITLE}>
        <span className="label">CUT</span>
        <div className="mixer__mode-tabs">
          <button
            type="button"
            className={eqMode === 'eq' ? 'active' : undefined}
            aria-pressed={eqMode === 'eq'}
            onClick={() => setEqMode('eq')}
          >
            EQ
          </button>
          <button
            type="button"
            className={eqMode === 'isolator' ? 'active' : undefined}
            aria-pressed={eqMode === 'isolator'}
            onClick={() => setEqMode('isolator')}
          >
            ISO
          </button>
        </div>
      </div>

      {CHANNEL_KNOBS.map((spec) => (
        <div className="mixer__row mixer__row--knobs" key={spec.id}>
          <Knob
            deck="A"
            label={spec.label}
            value={eq.A[spec.id]}
            readout={spec.format(eq.A[spec.id], eqMode)}
            onChange={(value) => setChannelKnob('A', spec.id, value)}
            onReset={() => resetChannelKnob('A', spec.id)}
          />
          <span className="mixer__row-label label">{spec.label}</span>
          <Knob
            deck="B"
            label={spec.label}
            value={eq.B[spec.id]}
            readout={spec.format(eq.B[spec.id], eqMode)}
            onChange={(value) => setChannelKnob('B', spec.id, value)}
            onReset={() => resetChannelKnob('B', spec.id)}
          />
        </div>
      ))}

      <div className="mixer__row mixer__row--faders">
        {DECKS.map((id) => (
          <ChannelFader
            key={id}
            value={id === 'A' ? faderA : faderB}
            ariaLabel={`Deck ${id} channel fader`}
            onChange={(value) => setFader(id, value)}
          />
        ))}
      </div>

      <div className="mixer__crossfader">
        <span className="label">A</span>
        <Crossfader value={crossfade} onChange={setCrossfade} ariaLabel="Crossfader" />
        <span className="label">B</span>
      </div>
    </div>
  )
}
