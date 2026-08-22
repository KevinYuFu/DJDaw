/// <reference types="vite/client" />
import { useCallback, useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { useArrangement, ZOOM_LEVELS } from '@renderer/state/useArrangement'
import { canvasNeedsResize, sizeCanvas } from '@renderer/components/waveform/waveformRender'
import { gridLines, gridStepSec, timeLabel } from './timeline'

/**
 * The timeline above the lanes.
 *
 * It reads the same zoom and scroll every lane does, so its ticks line up with
 * the grid drawn behind the clips. Clicking it puts the playhead there.
 */

const TICK = 'rgba(255,255,255,0.45)'
const TEXT = 'rgba(255,255,255,0.62)'
const PLAYHEAD = '#ff4d4d'

export function ArrangementRuler(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef({ width: 0, height: 0 })
  const zoomIndex = useArrangement((s) => s.zoomIndex)
  const scrollSec = useArrangement((s) => s.scrollSec)
  const playheadSec = useArrangement((s) => s.playheadSec)
  const frameRef = useRef({ zoomIndex, scrollSec, playheadSec })
  frameRef.current = { zoomIndex, scrollSec, playheadSec }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) boxRef.current = { width: rect.width, height: rect.height }
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
      canvasNeedsResize(canvas, width, height, dpr)
      const ctx = sizeCanvas(canvas, width, height, dpr)
      if (!ctx) return
      ctx.clearRect(0, 0, width, height)

      const { zoomIndex: zoom, scrollSec: from, playheadSec: head } = frameRef.current
      const pxPerSec = ZOOM_LEVELS[zoom]
      const step = gridStepSec(pxPerSec)
      ctx.save()
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.textBaseline = 'top'
      for (const sec of gridLines(from, from + width / pxPerSec, step)) {
        const x = Math.round((sec - from) * pxPerSec) + 0.5
        ctx.fillStyle = TICK
        ctx.fillRect(x, height - 6, 1, 6)
        ctx.fillStyle = TEXT
        ctx.fillText(timeLabel(sec, step), x + 3, 3)
      }
      ctx.restore()

      const headX = (head - from) * pxPerSec
      if (headX >= 0 && headX <= width) {
        ctx.fillStyle = PLAYHEAD
        ctx.fillRect(Math.round(headX), 0, 1, height)
        // A tab on the ruler, so the playhead can be picked out of the lanes
        // even where the audio behind it is bright.
        ctx.beginPath()
        ctx.moveTo(Math.round(headX) - 4, 0)
        ctx.lineTo(Math.round(headX) + 5, 0)
        ctx.lineTo(Math.round(headX) + 0.5, 7)
        ctx.closePath()
        ctx.fill()
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  const seek = useCallback((clientX: number): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const { zoomIndex: zoom, scrollSec: from } = frameRef.current
    useArrangement.getState().seek(from + (clientX - rect.left) / ZOOM_LEVELS[zoom])
  }, [])

  return (
    <div className="arrange-ruler">
      <div className="arrange-ruler__spacer" />
      <canvas
        className="arrange-ruler__canvas"
        ref={canvasRef}
        onPointerDown={(event) => seek(event.clientX)}
      />
      <div className="arrange-ruler__spacer" />
    </div>
  )
}
