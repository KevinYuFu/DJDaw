import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { ChannelEq, EqMode } from '@shared/eq'
import { CENTRE, eqGainDb, formatDb, formatFilter, isFlat, trimGainDb } from '@shared/eq'
import { FADER_UNITY, formatFaderDb } from '@shared/fader'
import { clamp } from '@renderer/core/format'
import { useSettings } from '@renderer/state/useSettings'

/**
 * The level, EQ and filter for one channel.
 *
 * Driven by values and callbacks rather than by a deck, so the editing view
 * points them at a deck and the arrangement view points them at a track.
 */

const KNOB_TRAVEL_PX = 140

/** Drawn small: five of these plus a button share the width of the pad row. */
const KNOB_SIZE = 26
const KNOB_RADIUS = 10
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
 * The mixer stacks HI at the top and LOW at the bottom, which is the layout of
 * every DJ mixer, and it stays that way. That is a vertical convention though.
 * Laid out horizontally these have to read the way frequency does, low on the
 * left, the way a spectrum or a piano runs. The two orders disagree on
 * purpose; do not make one match the other.
 */
const EQ_KNOBS: readonly EqKnobSpec[] = [
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
  /** Pointer position where the drag began: clientY for a knob, clientX for the slider. */
  start: number
  startValue: number
}

/** Pointer travel, in px, for the whole of the fader. */
const FADER_TRAVEL_PX = 150

export interface ChannelFaderProps {
  /** Names the control for anyone reading the screen. */
  label: string
  /** 0-1 position. */
  position: number
  disabled: boolean
  onChange(position: number): void
}

/**
 * The channel fader for one row.
 *
 * Vertical, and tapered like a DAW fader rather than a mixer's trim: silent at
 * the bottom, 0 dB near the top and a little headroom over it. Sits between the
 * waveform and the rest of the controls because it is the one thing on the row
 * that is about the level of the track rather than about editing it.
 */
export function ChannelFader({
  label,
  position,
  disabled,
  onChange
}: ChannelFaderProps): ReactElement {
  const drag = useRef<{ pointerId: number; startY: number; startValue: number } | null>(null)

  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { pointerId: e.pointerId, startY: e.clientY, startValue: position }
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    onChange(d.startValue + (d.startY - e.clientY) / FADER_TRAVEL_PX)
  }
  const onUp = (): void => {
    drag.current = null
  }

  const db = formatFaderDb(position)
  const pct = clamp(position, 0, 1) * 100
  return (
    <div className={`edit-fader${disabled ? ' is-disabled' : ''}`}>
      <div
        className="edit-fader__track"
        role="slider"
        aria-label={`${label} fader`}
        aria-disabled={disabled}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={`${db} dB`}
        title={`Level ${db} dB — drag to set, double-click for 0 dB`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => !disabled && onChange(FADER_UNITY)}
      >
        <div className="edit-fader__slot" />
        <div className="edit-fader__fill" style={{ height: `${pct}%` }} />
      </div>
      <span className="edit-fader__value mono">{db}</span>
    </div>
  )
}

export interface ChannelEqProps {
  /** Names the controls for anyone reading the screen. */
  label: string
  eq: ChannelEq
  disabled: boolean
  onKnob(id: keyof ChannelEq, value: number): void
  onResetKnob(id: keyof ChannelEq): void
  onResetAll(): void
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
export function ChannelEqStrip({
  label,
  eq,
  disabled,
  onKnob,
  onResetKnob,
  onResetAll
}: ChannelEqProps): ReactElement {
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
    drag.current = { ...spec, pointerId: e.pointerId, start: e.clientY, startValue }
    setReadout(`${spec.name} ${knobReadout(spec.id, startValue, eqMode)}`)
  }

  const onKnobMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    const value = clamp(d.startValue + (d.start - e.clientY) / KNOB_TRAVEL_PX, 0, 1)
    onKnob(d.id, value)
    setReadout(`${d.name} ${knobReadout(d.id, value, eqMode)}`)
  }

  const onKnobUp = (): void => {
    drag.current = null
    setReadout(null)
  }


  const onKnobReset = (spec: EqKnobSpec): void => {
    if (disabled) return
    onResetKnob(spec.id)
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
            aria-label={`${label} ${spec.name}`}
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
        onClick={onResetAll}
        title="Put every knob on this row back to flat"
      >
        <span>Flat</span>
      </button>
    </div>
  )
}

