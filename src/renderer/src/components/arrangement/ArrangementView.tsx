import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react'
import { useRaf } from '@renderer/hooks/useRaf'
import { useSettings } from '@renderer/state/useSettings'
import { canvasChrome, themeById } from '@renderer/styles/themes'
import { useArrangement } from '@renderer/state/useArrangement'
import { ArrangementLane } from '@renderer/components/arrangement/ArrangementLane'
import { BARS_PER_PHRASE } from '@renderer/components/arrangement/ArrangementClips'
import { WHEEL_STEP, zoomAbout } from '@renderer/arrangement/zoom'
import './arrangement.css'

/** Height of one lane's clip strip, in CSS pixels. */
const LANE_H = 84

/** Height of a lane that has been collapsed: its name and its buttons, no more. */
const LANE_H_SHUT = 30

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
  const themeId = useSettings((s) => s.themeId)
  const chrome = useMemo(() => canvasChrome(themeId), [themeId])
  // The ruler's numbers read as body text, so they come from the token the rest
  // of the chrome uses rather than from a second colour.
  const rulerText = useMemo(() => themeById(themeId).tokens['text-dim'], [themeId])
  const selected = useArrangement((s) => s.selection)
  const collapsed = useArrangement((s) => s.collapsed)
  const splitting = useArrangement((s) => s.splitting)
  // At most one split runs at a time, so the first is the one to show.
  const busy = Object.values(splitting)[0] ?? null
  const [width, setWidth] = useState(900)
  /**
   * Where the timeline is looking, held as one thing.
   *
   * A wheel sends a run of events faster than React re-renders, so each has to
   * work from the view the one before it left. Two pieces of state cannot do
   * that: the second event would read the first's stale value and zoom from
   * the wrong place.
   */
  const [view, setView] = useState({ fromBar: 0, barsInView: DEFAULT_BARS_IN_VIEW })
  const { fromBar, barsInView } = view
  const lanesRef = useRef<HTMLDivElement>(null)
  const laneBoxes = useRef(new Map<string, HTMLElement>())
  const registerLane = useCallback((id: string, el: HTMLElement | null): void => {
    if (el) laneBoxes.current.set(id, el)
    else laneBoxes.current.delete(id)
  }, [])
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
  //
  // Measured off a lane's own strip, not the overlay above it. The lanes
  // scroll and so reserve room for a scrollbar; the overlay does not, and is
  // that much wider. Measuring the wider one drew every bar slightly narrow
  // and put a zoom a few pixels off the pointer.
  useLayoutEffect(() => {
    const el = stripsRef.current
    if (!el) return
    const measure = (): void => {
      const strip = lanesRef.current?.querySelector('.arr-lane__strip')
      const across = strip ? strip.clientWidth : el.clientWidth
      setWidth(Math.max(120, across))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    if (lanesRef.current) observer.observe(lanesRef.current)
    return () => observer.disconnect()
  }, [ready])

  const barSec = (BEATS_PER_BAR * 60) / masterBpm
  const secPerPx = (barSec * barsInView) / width
  const fromSec = fromBar * barSec

  /**
   * What a wheel does, and only one thing at a time.
   *
   * - held Cmd or Ctrl: zoom, about whatever is under the pointer
   * - sideways, or Shift held: move along the timeline
   * - plain: leave it to the tracks, which scroll themselves
   *
   * Listened for directly rather than through React, because React attaches
   * wheel passively and a passive listener cannot stop the browser also acting
   * on the same gesture. Without that the tracks scrolled underneath a zoom.
   */
  useEffect(() => {
    const el = lanesRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        // Measured against the timeline itself, not the row it sits in: the
        // row also holds a track's name on the left and its channel on the
        // right, and counting those in puts the zoom off the pointer.
        const box = el.querySelector('.arr-lane__strip')?.getBoundingClientRect()
        if (!box || box.width <= 0) return
        const at = (e.clientX - box.left) / box.width
        const factor = e.deltaY > 0 ? WHEEL_STEP : 1 / WHEEL_STEP
        setView((v) => zoomAbout(v, at, factor, MIN_BARS_IN_VIEW, MAX_BARS_IN_VIEW))
        return
      }
      // Shift turns a wheel sideways, which is what it does everywhere else.
      const sideways = e.shiftKey ? e.deltaY : e.deltaX
      if (sideways === 0) return
      e.preventDefault()
      setView((v) => ({
        ...v,
        fromBar: Math.max(0, v.fromBar + (sideways * v.barsInView) / width)
      }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [width])

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
    // Counted off the timeline itself, exactly as the lanes count their own
    // lines, so the two cannot drift apart.
    const firstBar = Math.floor(fromSec / barSec)
    const lastBar = Math.ceil((fromSec + width * secPerPx) / barSec)
    for (let bar = firstBar; bar <= lastBar; bar++) {
      const x = Math.round((bar * barSec - fromSec) / secPerPx) + 0.5
      if (x < 0 || x > width) continue
      const major = bar % BARS_PER_PHRASE === 0
      ctx.strokeStyle = major ? chrome.gridPhrase : chrome.gridBar
      ctx.beginPath()
      ctx.moveTo(x, major ? 2 : 10)
      ctx.lineTo(x, h)
      ctx.stroke()
      if (major) {
        ctx.fillStyle = rulerText
        ctx.fillText(String(bar + 1), x + 3, 2)
      }
    }
  }, [width, barSec, secPerPx, fromSec, fromBar, barsInView, chrome, rulerText])

  // Moved directly, outside the store: it changes every frame.
  useRaf(() => {
    const head = headRef.current
    if (!head) return
    const at = useArrangement.getState().displaySeconds()
    head.style.transform = `translateX(${(at - fromSec) / secPerPx}px)`
  }, true)

  /**
   * The lane a screen position falls on, so a clip carried off its own lane
   * lands on the one under the pointer.
   *
   * Read off the lanes themselves rather than worked out from a row height:
   * a collapsed lane is shorter than an open one, and the list scrolls.
   */
  const laneAt = (clientY: number): string | null => {
    let nearest: { id: string; gap: number } | null = null
    for (const [id, el] of laneBoxes.current) {
      const box = el.getBoundingClientRect()
      if (clientY >= box.top && clientY < box.bottom) return id
      const gap = clientY < box.top ? box.top - clientY : clientY - box.bottom
      if (!nearest || gap < nearest.gap) nearest = { id, gap }
    }
    return nearest?.id ?? null
  }

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
          <button
            type="button"
            className="arr-btn arr-btn--split"
            disabled={!selected || busy !== null}
            onClick={() => void useArrangement.getState().splitSelectedStems()}
            title="Split the selected clip into drums, bass, other and vocals"
          >
            <span>{busy === null ? 'SPLIT' : `SPLIT ${Math.round(busy * 100)}%`}</span>
            {busy === null ? null : (
              <span className="arr-btn__meter" style={{ transform: `scaleX(${busy})` }} />
            )}
          </button>
          {notice ? <span className="arr-view__note is-warn">{notice}</span> : null}
          {loading.length > 0 ? <span className="arr-view__note">Loading a track…</span> : null}
        </div>
        <div className="arr-view__right">
          <button
            type="button"
            className="arr-btn"
            title="Show fewer bars"
            onClick={() =>
              setView((v) => zoomAbout(v, 0.5, 1 / 1.5, MIN_BARS_IN_VIEW, MAX_BARS_IN_VIEW))
            }
          >
            <span>+</span>
          </button>
          <button
            type="button"
            className="arr-btn"
            title="Show more bars"
            onClick={() =>
              setView((v) => zoomAbout(v, 0.5, 1.5, MIN_BARS_IN_VIEW, MAX_BARS_IN_VIEW))
            }
          >
            <span>−</span>
          </button>
          <span className="mono arr-view__grid">
            {Math.round(barsInView)} bars · {BEATS_PER_BAR}/4 · 1/4 snap
          </span>
        </div>
      </div>

      <div className="arr-view__ruler">
        <div className="arr-view__gutter" />
        {/* Held to the strip's width, not stretched across its own box: the
            lanes below reserve room for a scrollbar and the ruler does not, so
            filling both would draw the same bar at two different places. */}
        <canvas className="arr-view__ruler-canvas" ref={rulerRef} style={{ width }} />
        <div className="arr-view__tail" />
      </div>

      <div className="arr-view__stage">
        <div className="arr-view__lanes" ref={lanesRef}>
          {lanes.map((lane, index) => (
            <ArrangementLane
              key={lane.id}
              lane={lane}
              index={index}
              fromSec={fromSec}
              secPerPx={secPerPx}
              width={width}
              height={collapsed[lane.id] ? LANE_H_SHUT : LANE_H}
              collapsed={collapsed[lane.id] === true}
              barSec={barSec}
              beatsPerBar={BEATS_PER_BAR}
              selected={selected}
              onSelect={(next) => useArrangement.getState().select(next)}
              laneAt={laneAt}
              register={registerLane}
            />
          ))}
        </div>
        {/* Over the strips only, not the channel columns either side. The
            playhead spans what can be seen, so scrolling does not cut it. */}
        <div className="arr-view__overlay" ref={stripsRef}>
          <div className="arr-view__playhead" ref={headRef} />
        </div>
      </div>
    </div>
  )
}
