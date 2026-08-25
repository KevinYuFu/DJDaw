import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import {
  CENTRE,
  eqGainDb,
  formatDb,
  formatFilter,
  isFlat,
  trimGainDb,
  type ChannelEq,
  type EqMode
} from '@shared/eq'
import { FADER_UNITY, formatFaderDb } from '@shared/fader'
import { clamp } from '@renderer/core/format'

/**
 * Trim, three-band EQ and filter for one channel.
 *
 * Shared by every view with a channel strip. Told what to draw, so a caller
 * can keep its knobs wherever it likes.
 *
 * Its own component, so a knob move re-renders five small SVGs and not the
 * whole row.
 *
 * Knobs drag vertically, up for more; a double-click returns one to centre.
 * The live value goes in a readout above the strip, which has room for it.
 */

/** Pointer travel, in px, for the whole sweep of a knob. */
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
 * The mode reaches the three bands only, where it sets how deep a full cut
 * goes: in isolator mode the bottom of a band reads `KILL`.
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
  /** Fader position, 0 silent to 1 at the top. */
  position: number
  disabled: boolean
  /** What the fader is called, for a screen reader. */
  label: string
  /** Class-name prefix, so a view can style the fader as its own. */
  prefix?: string
  onChange(position: number): void
}

/**
 * The channel fader for one row or lane.
 *
 * Vertical and tapered: silent at the bottom, 0 dB near the top, a little
 * headroom over it.
 */
export function ChannelFader({
  position,
  disabled,
  label,
  prefix = 'v2-edit',
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
    <div className={`${prefix}-fader${disabled ? ' is-disabled' : ''}`}>
      <div
        className={`${prefix}-fader__track`}
        role="slider"
        aria-label={label}
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
        <div className={`${prefix}-fader__slot`} />
        <div className={`${prefix}-fader__fill`} style={{ height: `${pct}%` }} />
      </div>
      <span className={`${prefix}-fader__value mono`}>{db}</span>
    </div>
  )
}

export interface ChannelKnobsProps {
  /** What the channel is called, for a screen reader. */
  label: string
  /** The knob positions to draw. */
  eq: ChannelEq
  /** How deep a band cut goes, which changes what a knob reads. */
  mode: EqMode
  disabled: boolean
  /** Class-name prefix, so a view can style the strip as its own. */
  prefix?: string
  onChange(id: keyof ChannelEq, value: number): void
  onReset(id: keyof ChannelEq): void
  onFlat(): void
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
export function ChannelKnobs({
  label,
  eq,
  mode: eqMode,
  disabled,
  prefix = 'v2-edit',
  onChange,
  onReset,
  onFlat
}: ChannelKnobsProps): ReactElement {
  const [readout, setReadout] = useState<string | null>(null)
  const drag = useRef<EqDrag | null>(null)

  const onKnobDown = (e: ReactPointerEvent<HTMLDivElement>, spec: EqKnobSpec): void => {
    if (disabled || e.button !== 0) return
    // Capture, so a drag that wanders off the knob keeps feeding it.
    e.currentTarget.setPointerCapture(e.pointerId)
    const startValue = eq[spec.id]
    drag.current = { ...spec, pointerId: e.pointerId, start: e.clientY, startValue }
    setReadout(`${spec.name} ${knobReadout(spec.id, startValue, eqMode)}`)
  }

  const onKnobMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    const value = clamp(d.startValue + (d.start - e.clientY) / KNOB_TRAVEL_PX, 0, 1)
    onChange(d.id, value)
    setReadout(`${d.name} ${knobReadout(d.id, value, eqMode)}`)
  }

  const onKnobUp = (): void => {
    drag.current = null
    setReadout(null)
  }


  const onKnobReset = (spec: EqKnobSpec): void => {
    if (disabled) return
    onReset(spec.id)
    setReadout(null)
  }

  const flat = isFlat(eq)

  return (
    <div className={`${prefix}-eq`}>
      {readout !== null ? <span className={`${prefix}-note mono`}>{readout}</span> : null}

      {EQ_KNOBS.map((spec) => {
        const value = eq[spec.id]
        const angle = -KNOB_SWEEP / 2 + clamp(value, 0, 1) * KNOB_SWEEP
        const moved = Math.abs(value - CENTRE) > 0.001
        const [px, py] = polar(KNOB_RADIUS - 2, angle)
        const [ix, iy] = polar(KNOB_RADIUS * 0.3, angle)
        return (
          <div
            key={spec.id}
            className={`${prefix}-knob${moved ? ' is-moved' : ''}${disabled ? ' is-disabled' : ''}`}
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
              className={`${prefix}-knob__dial`}
              width={KNOB_SIZE}
              height={KNOB_SIZE}
              viewBox={`0 0 ${KNOB_SIZE} ${KNOB_SIZE}`}
              aria-hidden="true"
            >
              <circle
                className={`${prefix}-knob__body`}
                cx={KNOB_SIZE / 2}
                cy={KNOB_SIZE / 2}
                r={KNOB_RADIUS - 2.5}
              />
              <path
                className={`${prefix}-knob__track`}
                d={arcPath(KNOB_RADIUS, -KNOB_SWEEP / 2, KNOB_SWEEP / 2)}
              />
              {/* Filled out from 12 o'clock: centre is flat on all five, so
                  the arc reads as how far from flat the knob is. */}
              {moved ? (
                <path className={`${prefix}-knob__value`} d={arcPath(KNOB_RADIUS, 0, angle)} />
              ) : null}
              <line className={`${prefix}-knob__pointer`} x1={ix} y1={iy} x2={px} y2={py} />
            </svg>
            <span className={`${prefix}-knob__label`}>{spec.label}</span>
          </div>
        )
      })}

      <button
        type="button"
        className={`${prefix}-btn ${prefix}-btn--flat${flat ? '' : ' is-lit'}`}
        disabled={disabled || flat}
        onClick={onFlat}
        title="Put every knob on this row back to flat"
      >
        <span>Flat</span>
      </button>
    </div>
  )
}
