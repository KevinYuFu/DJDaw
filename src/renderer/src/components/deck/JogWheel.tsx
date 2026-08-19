import { useCallback, useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { DeckId } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import type { Deck } from '@renderer/audio/Deck'
import { useRaf } from '@renderer/hooks/useRaf'
import { useDecks } from '@renderer/state/useDecks'

export interface JogWheelProps {
  deckId: DeckId
}

/**
 * Seconds of audio in one revolution. A 1200 at 33 1/3 rpm comes round every
 * 1.8 s and CDJ platters inherited the feel, so a full turn of this one moves
 * the playhead by the same amount.
 */
const PLATTER_PERIOD_SEC = 1.8

const SIZE = 150
const RING_STROKE = 3
const RING_RADIUS = SIZE / 2 - RING_STROKE / 2 - 0.5
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
const TWO_PI = Math.PI * 2

interface DragState {
  pointerId: number
  /**
   * The deck the gesture started on. Scrub mode belongs to that deck and only
   * it can leave it, so the drag holds the instance rather than re-reading one
   * that may have gone by the time the pointer comes up.
   */
  deck: Deck
  /** Platter centre in client coordinates, fixed for the gesture. */
  cx: number
  cy: number
  /** Pointer angle at the last move, for unwrapped delta accumulation. */
  angle: number
  /** Radians turned since the grab. Deliberately unbounded — turns add up. */
  turned: number
  startSec: number
}

/** Shortest signed angle between two headings, so crossing 12 o'clock is small. */
function angleDelta(from: number, to: number): number {
  let d = to - from
  if (d > Math.PI) d -= TWO_PI
  else if (d < -Math.PI) d += TWO_PI
  return d
}

/**
 * The platter: the marker turns with the playhead, the outer ring shows how
 * far into the track it is, and dragging puts the deck into the worklet's
 * scrub mode, where it chases the pointer and sounds out what it passes over.
 *
 * Both animations are written onto refs from a rAF loop. The playhead is not
 * React state and must not become it.
 */
export function JogWheel({ deckId }: JogWheelProps): ReactElement {
  const status = useDecks((s) => s.decks[deckId].status)
  const rotorRef = useRef<HTMLDivElement>(null)
  const ringRef = useRef<SVGCircleElement>(null)
  const drag = useRef<DragState | null>(null)

  // `deck()` throws until the engine has initialised, which `ready` implies.
  const deck = status === 'ready' ? AudioEngine.shared().deck(deckId) : null

  useRaf(() => {
    if (!deck) return
    const pos = deck.positionSeconds()
    const rotor = rotorRef.current
    const ring = ringRef.current
    if (rotor) rotor.style.transform = `rotate(${((pos / PLATTER_PERIOD_SEC) % 1) * 360}deg)`
    if (ring) {
      const progress = deck.durationSec > 0 ? pos / deck.durationSec : 0
      ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress))
    }
  }, deck !== null)

  // An emptied deck keeps the last frame's angle and ring unless they are reset.
  useEffect(() => {
    if (deck) return
    if (rotorRef.current) rotorRef.current.style.transform = 'rotate(0deg)'
    if (ringRef.current) ringRef.current.style.strokeDashoffset = String(RING_CIRCUMFERENCE)
  }, [deck])

  /**
   * Leave scrub mode. Idempotent, and safe to call from anywhere: a worklet
   * left scrubbing chases a pointer that no longer exists, which is a deck that
   * is silent and deaf to the transport until something ends the scrub.
   */
  const endScrub = useCallback((): void => {
    const d = drag.current
    if (!d) return
    drag.current = null
    d.deck.endScrub()
  }, [])

  // A deck that stops being ready mid-gesture — ejected, or given another
  // track — takes its handlers' `deck` away with it, and unmounting mid-drag
  // means no pointer event ever arrives. Both end the scrub from here.
  useEffect(() => endScrub, [deck, endScrub])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !deck) return
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = {
      pointerId: e.pointerId,
      deck,
      cx,
      cy,
      angle: Math.atan2(e.clientY - cy, e.clientX - cx),
      turned: 0,
      startSec: deck.positionSeconds()
    }
    deck.beginScrub()
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    const angle = Math.atan2(e.clientY - d.cy, e.clientX - d.cx)
    d.turned += angleDelta(d.angle, angle)
    d.angle = angle
    // Screen y grows downward, so a positive delta is clockwise: forward.
    d.deck.scrubToSeconds(d.startSec + (d.turned / TWO_PI) * PLATTER_PERIOD_SEC)
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    endScrub()
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  return (
    <div className="jog">
      <svg className="jog-ring" viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <circle className="jog-ring-track" cx={SIZE / 2} cy={SIZE / 2} r={RING_RADIUS} strokeWidth={RING_STROKE} />
        <circle
          ref={ringRef}
          className="jog-ring-fill"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RING_RADIUS}
          strokeWidth={RING_STROKE}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>

      <div
        className={`jog-platter${deck ? '' : ' is-empty'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
        title="Drag to search through the track"
      >
        <div className="jog-rotor" ref={rotorRef}>
          <div className="jog-marker" />
        </div>
        <div className="jog-cap">{deckId}</div>
      </div>
    </div>
  )
}
