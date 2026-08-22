/// <reference types="vite/client" />
import { useCallback, useEffect, useRef } from 'react'
import type {
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement
} from 'react'
import { clipAt, dragEndEdge, dragStartEdge, moveClip } from '@shared/arrangement'
import { BAND_COLORS } from '@renderer/core/constants'
import { TRACK_DRAG_TYPE } from '@renderer/components/browser/TrackTable'
import {
  arrangementPlayhead,
  arrangementSource,
  useArrangement,
  ZOOM_LEVELS
} from '@renderer/state/useArrangement'
import { gridLines, gridStepSec } from './timeline'
import { CURSOR_END_EDGE, CURSOR_START_EDGE, edgeAt } from './clipCursor'
import { useSettings } from '@renderer/state/useSettings'
import {
  canvasNeedsResize,
  drawWaveform,
  fillColumns,
  sizeCanvas
} from '@renderer/components/waveform/waveformRender'
import type { WaveformColumns } from '@renderer/components/waveform/waveformRender'

/**
 * One lane of the arrangement: the clips on one track, over the shared grid.
 *
 * The window it draws is the same on every lane — one zoom and one scroll for
 * the whole arrangement — so a moment on one lane is the same moment on the
 * next. A track dragged in from the browser lands where it was dropped.
 */

/** How the outline round a clip is drawn. */
const CLIP_EDGE = 'rgba(255,255,255,0.55)'
const CLIP_EDGE_PICKED = 'rgba(255,255,255,0.9)'
const CLIP_BODY = 'rgba(255,255,255,0.05)'
const CLIP_HEADER_H = 11

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
  const mono = useSettings((s) => s.waveformColorMode === 'mono')
  const rgb = useSettings((s) => s.waveformColorMode === 'rgb')

  const frameRef = useRef({ clips, zoomIndex, scrollSec, selectedClipId, mono, rgb })
  useEffect(() => {
    frameRef.current = { clips, zoomIndex, scrollSec, selectedClipId, mono, rgb }
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

      // The same grid the ruler draws, so a lane lines up with the times above
      // it and with every other lane.
      ctx.save()
      ctx.fillStyle = 'rgba(255,255,255,0.06)'
      for (const sec of gridLines(from, from + width / pxPerSec, gridStepSec(pxPerSec))) {
        ctx.fillRect(Math.round((sec - from) * pxPerSec), 0, 1, height)
      }
      ctx.restore()
      const columns = Math.max(1, Math.round(width * dpr))
      if (!colsRef.current || colsRef.current.width !== columns) {
        colsRef.current = emptyColumns(columns)
      }
      const cols = colsRef.current
      cols.low.fill(0)
      cols.mid.fill(0)
      cols.high.fill(0)

      const body = height - CLIP_HEADER_H
      for (const clip of state.clips ?? []) {
        const x0 = (clip.startSec - from) * pxPerSec
        const x1 = (clip.startSec + clip.durationSec - from) * pxPerSec
        if (x1 <= 0 || x0 >= width) continue

        // A clip is drawn from its own file, so a lane can hold clips from
        // several at once.
        const source = arrangementSource(clip.sourceId)
        if (source?.waveform) {
          const c0 = Math.max(0, Math.floor(x0 * dpr))
          const c1 = Math.min(columns, Math.ceil(x1 * dpr))
          if (c1 > c0) {
            const secPerColumn = 1 / (pxPerSec * dpr)
            const s0 = clip.sourceOffsetSec + (c0 / dpr - x0) * (1 / pxPerSec)
            fillColumns(
              source.waveform,
              s0,
              s0 + (c1 - c0) * secPerColumn,
              cols,
              c0,
              c1 - c0,
              source.waveform.sampleRate
            )
          }
        }
      }

      drawWaveform(ctx, cols, {
        height: body,
        y: CLIP_HEADER_H,
        colors: BAND_COLORS,
        mono: mono ? BAND_COLORS.high : undefined,
        rgb,
        gain: WAVE_GAIN,
        subpixel: dpr
      })

      // The outline and its grab bar go over the audio, so the edges of a clip
      // stay readable however loud it is.
      for (const clip of state.clips ?? []) {
        const x0 = (clip.startSec - from) * pxPerSec
        const x1 = (clip.startSec + clip.durationSec - from) * pxPerSec
        if (x1 <= 0 || x0 >= width) continue
        const picked = clip.id === state.selectedClipId
        const left = Math.max(x0, 0)
        const right = Math.min(x1, width)
        ctx.save()
        ctx.fillStyle = picked ? 'rgba(255,255,255,0.13)' : CLIP_BODY
        ctx.fillRect(left, 0, right - left, CLIP_HEADER_H)
        ctx.strokeStyle = picked ? CLIP_EDGE_PICKED : CLIP_EDGE
        ctx.lineWidth = picked ? 2 : 1
        ctx.strokeRect(
          left + ctx.lineWidth / 2,
          ctx.lineWidth / 2,
          right - left - ctx.lineWidth,
          height - ctx.lineWidth
        )
        ctx.restore()
      }

      const headX = (arrangementPlayhead() - from) * pxPerSec
      if (headX >= 0 && headX <= width) {
        ctx.fillStyle = '#ff5a5a'
        ctx.fillRect(Math.round(headX), 0, 1, height)
      }
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [mono, rgb])

  /** What the pointer is holding, once it has gone down on a clip. */
  const holdRef = useRef<{
    pointerId: number
    clipId: string
    edge: 'start' | 'end' | null
    /** Where in the clip it took hold, for a move. */
    grabSec: number
  } | null>(null)

  /** Timeline seconds under a screen x. */
  const timeAt = useCallback((clientX: number): number => {
    const canvas = canvasRef.current
    if (!canvas) return 0
    const rect = canvas.getBoundingClientRect()
    const { zoomIndex: zoom, scrollSec: scroll } = frameRef.current
    return scroll + (clientX - rect.left) / ZOOM_LEVELS[zoom]
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

  /** The clip under the pointer and which of its edges, if any. */
  const hitTest = useCallback(
    (clientX: number): { clip: ReturnType<typeof clipAt>; edge: 'start' | 'end' | null } => {
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
          ? dragStartEdge(clips, hold.clipId, at)
          : hold.edge === 'end'
            ? dragEndEdge(clips, hold.clipId, at)
            : moveClip(clips, hold.clipId, at - hold.grabSec)
      useArrangement.getState().setClips(trackId, next)
    },
    [hitTest, timeAt, trackId]
  )

  const endHold = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const hold = holdRef.current
    if (!hold || hold.pointerId !== event.pointerId) return
    holdRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
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
      />
    </div>
  )
}
