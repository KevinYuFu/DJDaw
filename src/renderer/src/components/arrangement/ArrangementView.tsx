import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type WheelEvent as ReactWheelEvent
} from 'react'
import { clamp } from '@renderer/core/format'
import { useRaf } from '@renderer/hooks/useRaf'
import { useArrangement } from '@renderer/state/useArrangement'
import { ArrangementLane } from '@renderer/components/arrangement/ArrangementLane'
import './arrangement.css'

/** Height of one lane's clip strip, in CSS pixels. */
const LANE_H = 84

/** Bars across the width of the timeline, and how far the zoom goes. */
const DEFAULT_BARS_IN_VIEW = 32
const MIN_BARS_IN_VIEW = 4
const MAX_BARS_IN_VIEW = 256

/** How long a refused edit explains itself, in ms. */
const NOTICE_MS = 2200

/** Beats in a bar. 4/4 only. */
const BEATS_PER_BAR = 4

/**
 * The arrangement view: lanes of clips on one fixed grid.
 *
 * Every lane runs on that grid at the master tempo, and a clip is warped to it
 * as it lands. There is no per-lane tempo.
 */
export function ArrangementView(): ReactElement {
  const ready = useArrangement((s) => s.ready)
  const lanes = useArrangement((s) => s.lanes)
  const masterBpm = useArrangement((s) => s.masterBpm)
  const playing = useArrangement((s) => s.playing)
  const loading = useArrangement((s) => s.loading)
  const notice = useArrangement((s) => s.notice)
  const selected = useArrangement((s) => s.selection)
  const [width, setWidth] = useState(900)
  const [barsInView, setBarsInView] = useState(DEFAULT_BARS_IN_VIEW)
  const [fromBar, setFromBar] = useState(0)
  const stripsRef = useRef<HTMLDivElement>(null)
  const rulerRef = useRef<HTMLCanvasElement>(null)
  const headRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void useArrangement.getState().init()
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => useArrangement.getState().clearNotice(), NOTICE_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  // A bar is the same width whatever the window size is.
  useLayoutEffect(() => {
    const el = stripsRef.current
    if (!el) return
    const measure = (): void => setWidth(Math.max(120, el.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ready])

  const barSec = (BEATS_PER_BAR * 60) / masterBpm
  const secPerPx = (barSec * barsInView) / width
  const fromSec = fromBar * barSec

  /** Wheel scrolls the lanes; with a modifier it zooms about the pointer. */
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey) {
      const box = e.currentTarget.getBoundingClientRect()
      const atBar = fromBar + ((e.clientX - box.left) / width) * barsInView
      const next = clamp(
        barsInView * (e.deltaY > 0 ? 1.15 : 1 / 1.15),
        MIN_BARS_IN_VIEW,
        MAX_BARS_IN_VIEW
      )
      setBarsInView(next)
      setFromBar(Math.max(0, atBar - ((e.clientX - box.left) / width) * next))
      return
    }
    const travel = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    setFromBar((bar) => Math.max(0, bar + (travel * secPerPx) / barSec))
  }

  // The bar ruler, redrawn when the grid or the panel changes.
  useEffect(() => {
    const canvas = rulerRef.current
    if (!canvas) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const h = 20
    canvas.width = Math.floor(width * dpr)
    canvas.height = Math.floor(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, h)
    ctx.font = '9px ui-monospace, monospace'
    ctx.textBaseline = 'top'
    for (let bar = 0; bar <= barsInView; bar++) {
      const x = Math.round(((bar + Math.round(fromBar)) * barSec - fromSec) / secPerPx) + 0.5
      const major = (bar + Math.round(fromBar)) % 4 === 0
      ctx.strokeStyle = major ? 'rgba(200, 214, 236, 0.5)' : 'rgba(150, 170, 200, 0.22)'
      ctx.beginPath()
      ctx.moveTo(x, major ? 2 : 10)
      ctx.lineTo(x, h)
      ctx.stroke()
      if (major) {
        ctx.fillStyle = 'rgba(210, 222, 240, 0.75)'
        ctx.fillText(String(bar + Math.round(fromBar) + 1), x + 3, 2)
      }
    }
  }, [width, barSec, secPerPx, fromSec, fromBar, barsInView])

  // Moved directly, outside the store: it changes every frame.
  useRaf(() => {
    const head = headRef.current
    if (!head) return
    const at = useArrangement.getState().displaySeconds()
    head.style.transform = `translateX(${(at - fromSec) / secPerPx}px)`
  }, true)

  return (
    <div className="arr-view">
      <div className="arr-view__bar">
        <div className="arr-view__left">
          <button
            type="button"
            className={`arr-btn arr-btn--play${playing ? ' is-lit' : ''}`}
            onClick={() => useArrangement.getState().toggle()}
            title="Play every lane from the playhead"
          >
            <span>{playing ? 'STOP' : 'PLAY'}</span>
          </button>
          <button
            type="button"
            className="arr-btn"
            onClick={() => useArrangement.getState().cutSelected()}
            title="Cut the selected clip at the playhead"
          >
            <span>CUT</span>
          </button>
          <button
            type="button"
            className="arr-btn"
            disabled={!selected}
            onClick={() => useArrangement.getState().removeSelected()}
            title="Delete the selected clip"
          >
            <span>DELETE</span>
          </button>
          {notice ? <span className="arr-view__note is-warn">{notice}</span> : null}
          {loading.length > 0 ? <span className="arr-view__note">Loading a track…</span> : null}
        </div>
        <div className="arr-view__right">
          <button
            type="button"
            className="arr-btn"
            title="Show fewer bars"
            onClick={() => setBarsInView((n) => Math.max(MIN_BARS_IN_VIEW, n / 1.5))}
          >
            <span>+</span>
          </button>
          <button
            type="button"
            className="arr-btn"
            title="Show more bars"
            onClick={() => setBarsInView((n) => Math.min(MAX_BARS_IN_VIEW, n * 1.5))}
          >
            <span>−</span>
          </button>
          <span className="mono arr-view__grid">
            {Math.round(barsInView)} bars · {BEATS_PER_BAR}/4 · 1 bar snap
          </span>
        </div>
      </div>

      <div className="arr-view__ruler">
        <div className="arr-view__gutter" />
        <canvas className="arr-view__ruler-canvas" ref={rulerRef} />
        <div className="arr-view__tail" />
      </div>

      <div className="arr-view__lanes" onWheel={onWheel}>
        {lanes.map((lane) => (
          <ArrangementLane
            key={lane.id}
            lane={lane}
            fromSec={fromSec}
            secPerPx={secPerPx}
            width={width}
            height={LANE_H}
            barSec={barSec}
            beatsPerBar={BEATS_PER_BAR}
            selected={selected}
            onSelect={(next) => useArrangement.getState().select(next)}
          />
        ))}
        {/* Over the strips only, not the channel columns either side. */}
        <div className="arr-view__overlay" ref={stripsRef}>
          <div className="arr-view__playhead" ref={headRef} />
        </div>
      </div>
    </div>
  )
}
