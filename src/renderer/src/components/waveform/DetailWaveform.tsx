/// <reference types="vite/client" />
import { useCallback, useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement, WheelEvent as ReactWheelEvent } from 'react'
import type { Clip } from '@shared/clips'
import { clipAt } from '@shared/clips'
import type { BeatGrid, DeckId, HotCue, MemoryCue, WaveformData } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import type { Deck } from '@renderer/audio/Deck'
import { BAND_COLORS, WAVE_ZOOM_LEVELS } from '@renderer/core/constants'
import { clamp } from '@renderer/core/format'
import { useDecks } from '@renderer/state/useDecks'
import { useLibrary } from '@renderer/state/useLibrary'
import { useSettings } from '@renderer/state/useSettings'
import {
  DETAIL_CUE_STYLE,
  DETAIL_LOCATOR_STYLE,
  type WaveformColumns,
  buildClipColumns,
  canvasNeedsResize,
  drawBeatGrid,
  drawClipEdges,
  drawClipHighlight,
  drawCueMarkers,
  drawLocators,
  drawLoopRegion,
  drawPlayhead,
  drawWaveform,
  sizeCanvas
} from './waveformRender'
import './waveform.css'

/**
 * The scrolling detail view, the CDJ's main waveform.
 *
 * The playhead is nailed to the horizontal centre and the track slides under
 * it, which is what makes two decks readable side by side: the same pixel is
 * "now" on both. Everything is redrawn per frame from the engine's playhead —
 * at these zoom levels only a couple of thousand buckets are in view, so a
 * full redraw is cheaper than any scroll-and-patch scheme would be.
 *
 * Dragging scrubs the deck the way a platter does; the wheel changes zoom.
 */

export interface DetailWaveformProps {
  deckId: DeckId
  /**
   * Let a click pick the piece under the pointer. On in the editing view,
   * where the pieces are the thing being worked on, and off on a performance
   * deck, which has nothing to select but the whole track.
   */
  selectClips?: boolean
}

/** Matches the overview, so the same track reads at the same weight in both. */
const WAVE_GAIN = 1.2

/** Mono mode collapses the bands into the high band's near-white. */
const MONO_COLOR = BAND_COLORS.high

/** Playhead movement below this is invisible, so the frame can be skipped. */
const MIN_PLAYHEAD_STEP_PX = 0.2

/**
 * Wheel delta for one zoom step. A trackpad fires a stream of small deltas,
 * and stepping on each one would race through every level in a flick.
 */
const WHEEL_STEP = 40
/** Rough pixels per line / page, for mice that report in those units. */
const WHEEL_LINE_PX = 16
const WHEEL_PAGE_PX = 100

const NO_CLIPS: readonly Clip[] = []
const NO_HOT_CUES: readonly HotCue[] = []
const NO_LOCATORS: readonly MemoryCue[] = []

/** Pointer travel below this is a click, above it a scrub. */
const CLICK_SLOP_PX = 3

interface LoopRegion {
  active: boolean
  startSec: number
  endSec: number
}

/** Everything a frame draws, kept in a ref so the rAF loop never re-subscribes. */
interface FrameState {
  deck: Deck | null
  waveform: WaveformData | null
  grid: BeatGrid | null
  hotCues: readonly HotCue[]
  cuePoint: number | null
  /** Locators. Stored on the track as `memoryCues`, the rekordbox name. */
  locators: readonly MemoryCue[]
  loop: LoopRegion | null
  /** The pieces the row is made of, in timeline order. */
  clips: readonly Clip[]
  selectedClipId: string | null
  /** Seconds of audio across the full width. */
  span: number
  mono: boolean
  rgb: boolean
}

export function DetailWaveform({ deckId, selectClips = false }: DetailWaveformProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef({ width: 0, height: 0 })
  const columnsRef = useRef<WaveformColumns | null>(null)
  const dirtyRef = useRef(true)
  const dragRef = useRef<{
    deck: Deck
    startX: number
    startTime: number
    /** Canvas left edge at pointer-down, so a click can be turned into a time. */
    canvasLeft: number
  } | null>(null)
  const wheelRef = useRef(0)

  const status = useDecks((s) => s.decks[deckId].status)
  const waveform = useDecks((s) => s.decks[deckId].waveform)
  const trackId = useDecks((s) => s.decks[deckId].trackId)
  const loop = useDecks((s) => s.decks[deckId].loop)
  const clips = useDecks((s) => s.decks[deckId].clips)
  const selectedClipId = useDecks((s) => s.decks[deckId].selectedClipId)
  const zoomIndex = useDecks((s) => s.decks[deckId].zoomIndex)
  const track = useLibrary((s) => (trackId ? (s.trackById(trackId) ?? null) : null))
  const mono = useSettings((s) => s.waveformColorMode === 'mono')
  const rgb = useSettings((s) => s.waveformColorMode === 'rgb')

  const span = WAVE_ZOOM_LEVELS[clamp(Math.round(zoomIndex), 0, WAVE_ZOOM_LEVELS.length - 1)]

  const frameRef = useRef<FrameState>({
    deck: null,
    waveform: null,
    grid: null,
    hotCues: NO_HOT_CUES,
    cuePoint: null,
    locators: NO_LOCATORS,
    loop: null,
    clips: NO_CLIPS,
    selectedClipId: null,
    span: WAVE_ZOOM_LEVELS[0],
    mono: false,
    rgb: false
  })

  // No dependency list: this is the one place the slow-changing store values
  // cross into the render loop, and it must run after every render.
  useEffect(() => {
    frameRef.current = {
      // `deck()` throws until the engine has initialised, which `ready` implies.
      deck: status === 'ready' ? AudioEngine.shared().deck(deckId) : null,
      waveform,
      grid: track?.grid ?? null,
      hotCues: track?.hotCues ?? NO_HOT_CUES,
      cuePoint: track?.cuePoint ?? null,
      locators: track?.memoryCues ?? NO_LOCATORS,
      loop,
      clips,
      selectedClipId,
      span,
      mono,
      rgb
    }
    dirtyRef.current = true
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const measure = (width: number, height: number): void => {
      boxRef.current = { width, height }
      dirtyRef.current = true
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) measure(rect.width, rect.height)
    })
    observer.observe(canvas)
    const rect = canvas.getBoundingClientRect()
    measure(rect.width, rect.height)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0
    let lastPosition = Number.NaN

    const frame = (): void => {
      raf = requestAnimationFrame(frame)
      const { width, height } = boxRef.current
      if (width <= 0 || height <= 0) return
      const dpr = window.devicePixelRatio || 1
      const state = frameRef.current

      const position = state.deck ? state.deck.positionSeconds() : 0
      const pxPerSecond = width / state.span
      const resized = canvasNeedsResize(canvas, width, height, dpr)
      const moved = Math.abs(position - lastPosition) * pxPerSecond
      if (!dirtyRef.current && !resized && moved < MIN_PLAYHEAD_STEP_PX) return
      dirtyRef.current = false
      lastPosition = position

      const ctx = sizeCanvas(canvas, width, height, dpr)
      if (!ctx) return
      ctx.clearRect(0, 0, width, height)

      // The playhead is fixed at the centre, so the window is centred on it
      // and runs off both ends of the track at the head and tail.
      const from = position - state.span / 2
      const to = position + state.span / 2

      drawClipHighlight(ctx, state.clips, state.selectedClipId, from, to, width, height)

      if (state.waveform) {
        // Per clip, not per pixel: each piece draws the slice of the file its
        // `sourceOffsetSec` points at, so a cut row shows what it plays and a
        // deleted piece leaves the background bare.
        const cols = buildClipColumns(
          state.waveform,
          state.clips,
          from,
          to,
          width,
          state.waveform.sampleRate,
          columnsRef.current
        )
        columnsRef.current = cols
        drawWaveform(ctx, cols, {
          height,
          colors: BAND_COLORS,
          mono: state.mono ? MONO_COLOR : undefined,
          rgb: state.rgb,
          gain: WAVE_GAIN
        })
      }
      if (state.loop?.active) {
        drawLoopRegion(ctx, state.loop.startSec, state.loop.endSec, from, to, width, height)
      }
      if (state.grid) drawBeatGrid(ctx, state.grid, from, to, width, height)
      // Locators first: they are the background the cues sit on, and this is
      // the MICRO view, so their names have room.
      drawLocators(ctx, state.locators, from, to, width, height, DETAIL_LOCATOR_STYLE)
      drawCueMarkers(ctx, state.hotCues, state.cuePoint, from, to, width, height, DETAIL_CUE_STYLE)
      drawClipEdges(ctx, state.clips, state.selectedClipId, from, to, width, height)
      drawPlayhead(ctx, width / 2, height)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0) return
    const { deck } = frameRef.current
    if (!deck) return
    event.currentTarget.setPointerCapture(event.pointerId)
    // The deck is captured with the gesture: a track loaded mid-drag must not
    // leave the old one stuck in scrub mode.
    dragRef.current = {
      deck,
      startX: event.clientX,
      startTime: deck.positionSeconds(),
      canvasLeft: event.currentTarget.getBoundingClientRect().left
    }
    deck.beginScrub()
  }, [])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    const { width } = boxRef.current
    if (!drag || width <= 0) return
    // Dragging right pulls the track backwards under the fixed playhead, which
    // is the direction a platter moves the audio.
    const secondsPerPixel = frameRef.current.span / width
    drag.deck.scrubToSeconds(drag.startTime - (event.clientX - drag.startX) * secondsPerPixel)
  }, [])

  const endScrub = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      drag.deck.endScrub()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }

      // A press that went nowhere was a click, and a click picks the piece
      // under it. The playhead did not move, so the window is still the one
      // the press landed in and `startTime` is still its centre.
      const { width } = boxRef.current
      if (!selectClips || width <= 0) return
      if (Math.abs(event.clientX - drag.startX) > CLICK_SLOP_PX) return
      const { clips: rowClips, span: rowSpan } = frameRef.current
      const offsetPx = event.clientX - drag.canvasLeft - width / 2
      const timelineSec = drag.startTime + offsetPx * (rowSpan / width)
      // Clicking a gap selects nothing, the way clicking empty space in a DAW
      // clears the selection.
      const clip = clipAt(rowClips, timelineSec)
      useDecks.getState().selectClip(deckId, clip ? clip.id : null)
    },
    [deckId, selectClips]
  )

  const onWheel = useCallback(
    (event: ReactWheelEvent<HTMLCanvasElement>): void => {
      const delta =
        event.deltaMode === 1
          ? event.deltaY * WHEEL_LINE_PX
          : event.deltaMode === 2
            ? event.deltaY * WHEEL_PAGE_PX
            : event.deltaY
      // A reversal starts a fresh gesture, so flicking back zooms back at once.
      const accumulated = (wheelRef.current > 0) === (delta > 0) ? wheelRef.current + delta : delta
      const steps = Math.trunc(accumulated / WHEEL_STEP)
      wheelRef.current = accumulated - steps * WHEEL_STEP
      if (steps === 0) return
      // The accumulator is a ref and survives every render, so the index it
      // steps from has to be read now: a wheel can produce several steps
      // before React re-renders, and a captured index would apply each of them
      // to the same stale level and drop all but the last.
      const { decks, setZoom } = useDecks.getState()
      // Scrolling down shows more of the track, as it does in rekordbox.
      setZoom(deckId, decks[deckId].zoomIndex + steps)
    },
    [deckId]
  )

  return (
    <div className="waveform-detail">
      <canvas
        ref={canvasRef}
        className="waveform-detail__canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
        onLostPointerCapture={endScrub}
        onWheel={onWheel}
      />
    </div>
  )
}

export default DetailWaveform
