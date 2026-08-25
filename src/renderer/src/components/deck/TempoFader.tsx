import { useRef } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { DeckId } from '@shared/types'
import { TEMPO_RANGES } from '@renderer/core/constants'
import { clamp, formatPitch } from '@renderer/core/format'
import { useDecks } from '@renderer/state/useDecks'

export interface TempoFaderProps {
  deckId: DeckId
}

/** Shift shrinks a full-travel drag to this fraction of the range. */
const FINE_FACTOR = 0.15

/** Percent positions of the printed scale marks, top to bottom. */
const TICKS = [0, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100] as const

interface DragState {
  pointerId: number
  lastY: number
  /** Fader value carried between moves, so a drag never waits on a re-render. */
  pitch: number
  height: number
}

function rangeLabel(range: number): string {
  return range >= 100 ? 'Wide' : `±${range}%`
}

function tickLabel(value: number): string {
  if (value === 0) return '0'
  const magnitude = Number.isInteger(value) ? String(Math.abs(value)) : Math.abs(value).toFixed(1)
  return `${value > 0 ? '+' : '-'}${magnitude}`
}

/** Buttons that keep focus swallow the Space shortcut. */
function preventFocus(e: ReactMouseEvent<HTMLElement>): void {
  e.preventDefault()
}

/**
 * The tempo fader.
 *
 * Plus is at the bottom, as on a CDJ and a 1200: pulling the fader towards you
 * speeds the track up. Dragging is relative, so shift makes a gesture finer
 * than the pixels it covers, and the value stops dead at the ends.
 */
export function TempoFader({ deckId }: TempoFaderProps): ReactElement {
  const deck = useDecks((s) => s.decks[deckId])
  const slotRef = useRef<HTMLDivElement>(null)
  const drag = useRef<DragState | null>(null)

  const range = deck.tempoRange
  const pitch = deck.pitchPercent
  const handlePct = ((pitch + range) / (2 * range)) * 100

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const slot = slotRef.current
    if (!slot) return
    const rect = slot.getBoundingClientRect()
    if (rect.height <= 0) return

    let start = pitch
    const onHandle = e.target instanceof HTMLElement && e.target.classList.contains('tempo-handle')
    if (!onHandle) {
      // Clicking the groove takes the fader there first, then drags from it.
      start = clamp(-range + ((e.clientY - rect.top) / rect.height) * 2 * range, -range, range)
      useDecks.getState().setPitch(deckId, start)
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { pointerId: e.pointerId, lastY: e.clientY, pitch: start, height: rect.height }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    const dy = e.clientY - d.lastY
    d.lastY = e.clientY
    // Read shift per move, so the gear can be changed mid-drag.
    const span = 2 * range * (e.shiftKey ? FINE_FACTOR : 1)
    d.pitch = clamp(d.pitch + (dy / d.height) * span, -range, range)
    useDecks.getState().setPitch(deckId, d.pitch)
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    drag.current = null
  }

  const reset = (): void => {
    drag.current = null
    useDecks.getState().setPitch(deckId, 0)
  }

  const cycleRange = (): void => {
    // The tuple is readonly literals; a plain number needs the widened view.
    const ranges: readonly number[] = TEMPO_RANGES
    const next = ranges[(ranges.indexOf(range) + 1) % ranges.length]
    useDecks.getState().setTempoRange(deckId, next)
  }

  return (
    <div className="tempo" onMouseDown={preventFocus}>
      <div className="tempo-readout mono">{formatPitch(pitch)}</div>

      <div className="tempo-body">
        <div className="tempo-scale">
          {[-range, -range / 2, 0, range / 2, range].map((value, i) => (
            <span key={value} className="tempo-scale-mark" style={{ top: `${i * 25}%` }}>
              {tickLabel(value)}
            </span>
          ))}
        </div>

        <div
          className="tempo-slot"
          ref={slotRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={reset}
          title="Drag to change tempo, shift-drag for fine control, double-click for 0.00%"
        >
          {TICKS.map((pct) => (
            <div key={pct} className={`tempo-tick${pct === 50 ? ' is-zero' : ''}`} style={{ top: `${pct}%` }} />
          ))}
          <div className="tempo-groove" />
          <div className="tempo-handle" style={{ top: `${handlePct}%` }} />
        </div>
      </div>

      <button type="button" className="tempo-btn" onClick={cycleRange} title="Tempo fader range">
        {rangeLabel(range)}
      </button>

      <button
        type="button"
        className="tempo-btn tempo-master"
        disabled
        title="Master tempo holds the musical key while the tempo moves. It needs a time-stretcher, which is not built yet."
      >
        Master Tempo
      </button>
    </div>
  )
}
