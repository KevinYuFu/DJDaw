import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * Per-frame callbacks and the escape hatch that keeps them out of React.
 *
 * The playhead moves 60 times a second. Anything driven by it — clocks, beat
 * counters, waveforms — reads the position inside a rAF callback and writes
 * straight to the DOM or a canvas, because routing that through `setState`
 * would re-render the app on every frame.
 */

/**
 * Run `callback` once per animation frame while `active` is true, cancelling on
 * unmount. The callback may change identity freely: it is read through a ref,
 * so a new closure each render does not restart the loop.
 *
 * @param callback receives the `requestAnimationFrame` timestamp, in ms.
 */
export function useRaf(callback: (timeMs: number) => void, active = true): void {
  const latest = useRef(callback)
  useEffect(() => {
    latest.current = callback
  })

  useEffect(() => {
    if (!active) return
    let frame = 0
    const tick = (time: number): void => {
      // Scheduled before the callback runs, so one thrown frame — a canvas
      // that lost its context, say — does not silently kill the loop.
      frame = requestAnimationFrame(tick)
      latest.current(time)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [active])
}

/**
 * Write text into a DOM node without going through React. The comparison
 * matters: a clock that re-writes the same string every frame would otherwise
 * dirty the text node 60 times a second for nothing.
 */
export function setRefText(ref: RefObject<HTMLElement | null>, text: string): void {
  const el = ref.current
  if (el && el.textContent !== text) el.textContent = text
}

/**
 * A ref plus a stable setter for it, for readouts updated from a rAF loop:
 *
 * ```tsx
 * const [elapsedRef, setElapsed] = useTextRef<HTMLSpanElement>()
 * useRaf(() => setElapsed(formatTime(deck.positionSeconds())))
 * return <span ref={elapsedRef} className="mono" />
 * ```
 */
export function useTextRef<T extends HTMLElement = HTMLElement>(): [RefObject<T | null>, (text: string) => void] {
  const ref = useRef<T | null>(null)
  const write = useCallback((text: string) => setRefText(ref, text), [])
  return [ref, write]
}
