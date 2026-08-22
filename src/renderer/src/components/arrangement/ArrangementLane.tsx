/// <reference types="vite/client" />
import { useCallback, useEffect, useRef } from 'react'
import type {
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  WheelEvent as ReactWheelEvent
} from 'react'
import type { ArrangementClip } from '@shared/arrangement'
import { clipAt, dragEndEdge, dragStartEdge, moveClip } from '@shared/arrangement'
import { BAND_COLORS } from '@renderer/core/constants'
import { TRACK_DRAG_TYPE } from '@renderer/components/browser/TrackTable'
import {
  arrangementPlayhead,
  arrangementSource,
  useArrangement,
  ZOOM_LEVELS
} from '@renderer/state/useArrangement'
import { useSettings } from '@renderer/state/useSettings'
import {
  canvasNeedsResize,
  DEFAULT_CLIP_STYLE,
  drawClipBands,
  drawClipEdges,
  drawClipHighlight,
  drawWaveform,
  fillColumns,
  sizeCanvas
} from '@renderer/components/waveform/waveformRender'
import type { WaveformColumns } from '@renderer/components/waveform/waveformRender'
import { gridBeats, gridLines, snapSec } from './timeline'
import { CURSOR_END_EDGE, CURSOR_START_EDGE, edgeAt } from './clipCursor'

/**
 * One lane of the arrangement: the clips on one track, over the shared grid.
 *
 * The window it draws is the same on every lane — one zoom and one scroll for
 * the whole arrangement — so a moment on one lane is the same moment on the
 * next. A track dragged in from the browser lands on the nearest bar.
 */

/** The clips are drawn exactly as the editing view draws them. */
const CLIP_STYLE = DEFAULT_CLIP_STYLE

/** The grid, drawn over everything so it reads on a clip as well as off one. */
const GRID_BAR = 'rgba(255,255,255,0.40)'
const GRID_BEAT = 'rgba(255,255,255,0.16)'
const PLAYHEAD = '#ff4d4d'

/** Peaks are lifted a little, as the deck strips do. */
const WAVE_GAIN = 0.9

function emptyColumns(width: number): WaveformColumns {
  return {
    width,
    low: new Float32Array(width),
    mid: new Float32Array(width),
    high: new Float32Array(width)
  }
}

export function ArrangementLane({ trackId }: { trackId: string }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef({ width: 0, height: 0 })
  const colsRef = useRef<WaveformColumns | null>(null)
  const dirtyRef = useRef(true)

  const clips = useArrangement((s) => s.tracks[trackId]?.clips)
  const zoomIndex = useArrangement((s) => s.zoomIndex)
  const scrollSec = useArrangement((s) => s.scrollSec)
  const selectedClipId = useArrangement((s) => s.selectedClipId)
  const bpm = useArrangement((s) => s.bpm)
  const mono = useSettings((s) => s.waveformColorMode === 'mono')
  const rgb = useSettings((s) => s.waveformColorMode === 'rgb')

  const frameRef = useRef({ clips, zoomIndex, scrollSec, selectedClipId, bpm, mono, rgb })
  useEffect(() => {
    frameRef.current = { clips, zoomIndex, scrollSec, selectedClipId, bpm, mono, rgb }
    dirtyRef.current = true
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      boxRef.current = { width: rect.width, height: rect.height }
      dirtyRef.current = true
    })
    observer.observe(canvas)
    const rect = canvas.getBoundingClientRect()
    boxRef.current = { width: rect.width, height: rect.height }
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0

    const frame = (): void => {
      raf = requestAnimationFrame(frame)
      const { width, height } = boxRef.current
      if (width <= 0 || height <= 0) return
      const dpr = window.devicePixelRatio || 1
      const resized = canvasNeedsResize(canvas, width, height, dpr)
      const running = useArrangement.getState().playing
      if (!dirtyRef.current && !resized && !running) return
      dirtyRef.current = false

      const ctx = sizeCanvas(canvas, width, height, dpr)
      if (!ctx) return
      ctx.clearRect(0, 0, width, height)

      const state = frameRef.current
      const pxPerSec = ZOOM_LEVELS[state.zoomIndex]
      const from = state.scrollSec
      const to = from + width / pxPerSec
      const clips = state.clips ?? []

      drawClipBands(ctx, clips, from, to, width, height, CLIP_STYLE)
      drawClipHighlight(ctx, clips, state.selectedClipId, from, to, width, height, CLIP_STYLE)

      // One set of columns for the whole lane, filled a clip at a time so each
      // one is read from its own file at its own speed.
      const columns = Math.max(1, Math.round(width * dpr))
      if (!colsRef.current || colsRef.current.width !== columns) {
        colsRef.current = emptyColumns(columns)
      }
      const cols = colsRef.current
      cols.low.fill(0)
      cols.mid.fill(0)
      cols.high.fill(0)

      for (const clip of clips) {
        const x0 = (clip.startSec - from) * pxPerSec
        const x1 = (clip.startSec + clip.durationSec - from) * pxPerSec
        if (x1 <= 0 || x0 >= width) continue
        const source = arrangementSource(clip.sourceId)
        if (!source?.waveform) continue
        const c0 = Math.max(0, Math.floor(x0 * dpr))
        const c1 = Math.min(columns, Math.ceil(x1 * dpr))
        if (c1 <= c0) continue
        // File seconds, so a clip locked to a faster tempo reads more of its
        // file for the same width on screen.
        const fileFrom = clip.sourceOffsetSec + (c0 / dpr - x0) * (clip.rate / pxPerSec)
        const fileTo = fileFrom + ((c1 - c0) / dpr) * (clip.rate / pxPerSec)
        fillColumns(source.waveform, fileFrom, fileTo, cols, c0, c1 - c0, source.waveform.sampleRate)
      }

      drawWaveform(ctx, cols, {
        height: height - CLIP_STYLE.handleHeight,
        y: CLIP_STYLE.handleHeight,
        colors: BAND_COLORS,
        mono: state.mono ? BAND_COLORS.high : undefined,
        rgb: state.rgb,
        gain: WAVE_GAIN,
        subpixel: dpr
      })

      // Over the audio, so the edges of a clip stay readable however loud it is.
      drawClipEdges(ctx, clips, state.selectedClipId, from, to, width, height, CLIP_STYLE)

      // The grid goes over the clips too. Behind them it would only show in the
      // empty stretches, which is where it is needed least.
      ctx.save()
      for (const line of gridLines(from, to, state.bpm, gridBeats(state.bpm, pxPerSec))) {
        ctx.fillStyle = line.onBar ? GRID_BAR : GRID_BEAT
        ctx.fillRect(Math.round((line.sec - from) * pxPerSec), 0, 1, height)
      }
      ctx.restore()

      const headX = (arrangementPlayhead() - from) * pxPerSec
      if (headX >= 0 && headX <= width) {
        ctx.fillStyle = PLAYHEAD
        ctx.fillRect(Math.round(headX), 0, 1, height)
      }
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  /** Timeline seconds under a screen x. */
  const timeAt = useCallback((clientX: number): number => {
    const canvas = canvasRef.current
    if (!canvas) return 0
    const rect = canvas.getBoundingClientRect()
    const { zoomIndex: zoom, scrollSec: scroll } = frameRef.current
    return scroll + (clientX - rect.left) / ZOOM_LEVELS[zoom]
  }, [])

  /** The nearest grid line, unless Alt is held for placing it by hand. */
  const onGrid = useCallback((sec: number, freehand: boolean): number => {
    const state = useArrangement.getState()
    if (freehand || !state.snap) return sec
    return snapSec(sec, state.bpm, gridBeats(state.bpm, ZOOM_LEVELS[state.zoomIndex]))
  }, [])

  const holdRef = useRef<{
    pointerId: number
    clipId: string
    edge: 'start' | 'end' | null
    /** Where in the clip it took hold, for a move. */
    grabSec: number
  } | null>(null)

  /** The clip under the pointer and which of its edges, if any. */
  const hitTest = useCallback(
    (clientX: number): { clip: ArrangementClip | null; edge: 'start' | 'end' | null } => {
      const canvas = canvasRef.current
      const clips = frameRef.current.clips ?? []
      if (!canvas) return { clip: null, edge: null }
      const rect = canvas.getBoundingClientRect()
      const pxPerSec = ZOOM_LEVELS[frameRef.current.zoomIndex]
      const from = frameRef.current.scrollSec
      const x = clientX - rect.left
      for (const clip of clips) {
        const x0 = (clip.startSec - from) * pxPerSec
        const x1 = (clip.startSec + clip.durationSec - from) * pxPerSec
        const edge = edgeAt(x, x0, x1)
        if (edge) return { clip, edge }
      }
      return { clip: clipAt(clips, timeAt(clientX)), edge: null }
    },
    [timeAt]
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      if (event.button !== 0) return
      const { clip, edge } = hitTest(event.clientX)
      useArrangement.getState().selectClip(trackId, clip ? clip.id : null)
      if (!clip) return
      event.currentTarget.setPointerCapture(event.pointerId)
      holdRef.current = {
        pointerId: event.pointerId,
        clipId: clip.id,
        edge,
        grabSec: timeAt(event.clientX) - clip.startSec
      }
    },
    [hitTest, timeAt, trackId]
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      const hold = holdRef.current
      if (!hold || hold.pointerId !== event.pointerId) {
        // Nothing held: the cursor says what the edge under it would do.
        const { edge } = hitTest(event.clientX)
        event.currentTarget.style.cursor =
          edge === 'start' ? CURSOR_START_EDGE : edge === 'end' ? CURSOR_END_EDGE : ''
        return
      }
      const clips = frameRef.current.clips ?? []
      const at = timeAt(event.clientX)
      const next =
        hold.edge === 'start'
          ? dragStartEdge(clips, hold.clipId, onGrid(at, event.altKey))
          : hold.edge === 'end'
            ? dragEndEdge(clips, hold.clipId, onGrid(at, event.altKey))
            : // The clip's own start lands on the line, not the spot in it the
              // hand took hold of.
              moveClip(clips, hold.clipId, onGrid(at - hold.grabSec, event.altKey))
      useArrangement.getState().setClips(trackId, next)
    },
    [hitTest, timeAt, trackId, onGrid]
  )

  const endHold = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const hold = holdRef.current
    if (!hold || hold.pointerId !== event.pointerId) return
    holdRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const onDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(TRACK_DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>): void => {
      const libraryTrackId = event.dataTransfer.getData(TRACK_DRAG_TYPE)
      if (!libraryTrackId) return
      event.preventDefault()
      void useArrangement.getState().dropTrack(trackId, libraryTrackId, timeAt(event.clientX))
    },
    [trackId, timeAt]
  )

  /**
   * The wheel moves along the timeline; with a modifier it zooms.
   *
   * Zooming holds the moment under the pointer still, so the thing being
   * looked at stays where it is instead of sliding away.
   */
  const onWheel = useCallback((event: ReactWheelEvent<HTMLCanvasElement>): void => {
    const state = useArrangement.getState()
    if (event.ctrlKey || event.metaKey) {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const under = state.scrollSec + (event.clientX - rect.left) / ZOOM_LEVELS[state.zoomIndex]
      const next = Math.max(
        0,
        Math.min(ZOOM_LEVELS.length - 1, state.zoomIndex + (event.deltaY < 0 ? 1 : -1))
      )
      if (next === state.zoomIndex) return
      state.setZoom(next)
      state.setScroll(under - (event.clientX - rect.left) / ZOOM_LEVELS[next])
      return
    }
    const along = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    state.setScroll(state.scrollSec + along / ZOOM_LEVELS[state.zoomIndex])
  }, [])

  return (
    <div className="arrange-lane" onDragOver={onDragOver} onDrop={onDrop}>
      <canvas
        className="arrange-lane__canvas"
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endHold}
        onPointerCancel={endHold}
        onLostPointerCapture={endHold}
        onWheel={onWheel}
      />
    </div>
  )
}
