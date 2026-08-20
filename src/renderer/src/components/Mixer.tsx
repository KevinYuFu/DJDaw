import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement, RefObject } from 'react'
import type { DeckId } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { clamp } from '@renderer/core/format'

/**
 * The centre strip between the decks.
 *
 * Only the channel faders and the crossfader are live: they multiply into each
 * deck's output gain through the engine. Trim, the three-band EQ and the filter
 * are drawn because the window should read as a mixer, but the DSP behind them
 * is not built, so every one of them is disabled and says so rather than moving
 * under the cursor and doing nothing.
 */

/**
 * The mixer is a two-channel unit, like the hardware it is modelled on. The
 * engine now carries four decks for the editing view, but only A and B are
 * wired through here, so the channel type stays narrower than `DeckId`.
 */
const DECKS = ['A', 'B'] as const satisfies readonly DeckId[]
type MixerChannel = (typeof DECKS)[number]

const NO_DSP_TITLE =
  'Not implemented yet — the mixer DSP (trim, 3-band EQ, filter) is not built. ' +
  'The channel faders and the crossfader are live.'

/** Cap height/width in px. Shared by the render and the hit maths. */
const FADER_CAP = 14
const CROSSFADER_CAP = 18

interface KnobSpec {
  id: string
  label: string
  /** 0-1 along the knob's 270-degree sweep. Static: these controls are inert. */
  value: number
  /** Bipolar knobs fill their arc out from 12 o'clock, like a real EQ. */
  bipolar: boolean
}

const CHANNEL_KNOBS: readonly KnobSpec[] = [
  { id: 'trim', label: 'TRIM', value: 0.5, bipolar: false },
  { id: 'hi', label: 'HI', value: 0.5, bipolar: true },
  { id: 'mid', label: 'MID', value: 0.5, bipolar: true },
  { id: 'low', label: 'LOW', value: 0.5, bipolar: true },
  { id: 'filter', label: 'FILTER', value: 0.5, bipolar: true }
]

const KNOB_SIZE = 30
const KNOB_RADIUS = 11
/** Sweep of a rotary control, -135 to +135 degrees, as on the hardware. */
const KNOB_SWEEP = 270

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

interface KnobProps extends Pick<KnobSpec, 'label' | 'value' | 'bipolar'> {
  deck: DeckId
}

function Knob({ label, value, bipolar, deck }: KnobProps): ReactElement {
  const angle = knobAngle(value)
  const from = bipolar ? 0 : -KNOB_SWEEP / 2
  const [px, py] = polar(KNOB_RADIUS - 2, angle)
  const [ix, iy] = polar(KNOB_RADIUS * 0.35, angle)
  return (
    <div
      className="knob is-disabled"
      title={NO_DSP_TITLE}
      role="slider"
      aria-disabled="true"
      aria-label={`Deck ${deck} ${label}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
    >
      <svg width={KNOB_SIZE} height={KNOB_SIZE} viewBox={`0 0 ${KNOB_SIZE} ${KNOB_SIZE}`} aria-hidden="true">
        <circle className="knob__body" cx={KNOB_SIZE / 2} cy={KNOB_SIZE / 2} r={KNOB_RADIUS - 2.5} />
        <path className="knob__track" d={arcPath(KNOB_RADIUS, -KNOB_SWEEP / 2, KNOB_SWEEP / 2)} />
        {Math.abs(angle - from) > 0.5 && <path className="knob__value" d={arcPath(KNOB_RADIUS, from, angle)} />}
        <line className="knob__pointer" x1={ix} y1={iy} x2={px} y2={py} />
      </svg>
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

/**
 * Constant-power crossfade: each deck sits at -3 dB in the centre, so a blend
 * of two tracks does not read as a dip in level the way a linear fade does.
 */
function crossfadeGains(position: number): { A: number; B: number } {
  const t = clamp(position, 0, 1) * (Math.PI / 2)
  return { A: Math.cos(t), B: Math.sin(t) }
}

/**
 * Push a level at the deck. The engine throws until `init()` has resolved, and
 * a fader moved during startup is not worth an exception at the UI — the
 * effect below re-pushes once the engine is up.
 */
function applyDeckGain(id: DeckId, gain: number): void {
  try {
    AudioEngine.shared().deck(id).setGain(gain)
  } catch {
    // Engine not ready yet; the post-init push covers it.
  }
}

export function Mixer(): ReactElement {
  const [levels, setLevels] = useState<Record<MixerChannel, number>>({ A: 1, B: 1 })
  const [crossfade, setCrossfade] = useState(0.5)

  const cross = crossfadeGains(crossfade)
  const gainA = levels.A * cross.A
  const gainB = levels.B * cross.B

  useEffect(() => {
    let live = true
    const push = (): void => {
      if (!live) return
      applyDeckGain('A', gainA)
      applyDeckGain('B', gainB)
    }
    push()
    // The opening -3 dB centre position has to reach the decks even though
    // nothing has been touched, so re-push as soon as the engine exists.
    void AudioEngine.shared()
      .init()
      .then(push)
      .catch(() => {
        // Startup failures are reported by the app shell, not by a fader.
      })
    return () => {
      live = false
    }
  }, [gainA, gainB])

  const setLevel = useCallback((id: DeckId, value: number) => {
    setLevels((prev) => (prev[id] === value ? prev : { ...prev, [id]: value }))
  }, [])

  return (
    <div className="mixer">
      <div className="mixer__row mixer__row--head">
        {DECKS.map((id) => (
          <span key={id} className="mixer__channel-id" data-deck={id}>
            {id}
          </span>
        ))}
      </div>

      {CHANNEL_KNOBS.map((knob) => (
        <div className="mixer__row mixer__row--knobs" key={knob.id}>
          <Knob deck="A" label={knob.label} value={knob.value} bipolar={knob.bipolar} />
          <span className="mixer__row-label label">{knob.label}</span>
          <Knob deck="B" label={knob.label} value={knob.value} bipolar={knob.bipolar} />
        </div>
      ))}

      <div className="mixer__row mixer__row--faders">
        {DECKS.map((id) => (
          <ChannelFader
            key={id}
            value={levels[id]}
            ariaLabel={`Deck ${id} channel fader`}
            onChange={(value) => setLevel(id, value)}
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
