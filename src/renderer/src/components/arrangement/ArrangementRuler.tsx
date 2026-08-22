/// <reference types="vite/client" />
import { useCallback, useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { useArrangement, ZOOM_LEVELS } from '@renderer/state/useArrangement'
import { canvasNeedsResize, sizeCanvas } from '@renderer/components/waveform/waveformRender'
import { barLabel, gridBeats, gridLines, snapSec } from './timeline'

/**
 * The bars above the lanes.
 *
 * It reads the same tempo, zoom and scroll every lane does, so its numbers sit
 * over the lines drawn behind the clips. Clicking it puts the playhead there.
 */

const TICK_BAR = 'rgba(255,255,255,0.55)'
const TICK_BEAT = 'rgba(255,255,255,0.26)'
const TEXT_BAR = 'rgba(255,255,255,0.78)'
const TEXT_BEAT = 'rgba(255,255,255,0.4)'
const PLAYHEAD = '#ff4d4d'

export function ArrangementRuler(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef({ width: 0, height: 0 })
  const zoomIndex = useArrangement((s) => s.zoomIndex)
  const scrollSec = useArrangement((s) => s.scrollSec)
  const bpm = useArrangement((s) => s.bpm)
  const frameRef = useRef({ zoomIndex, scrollSec, bpm })
  frameRef.current = { zoomIndex, scrollSec, bpm }

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

      const { zoomIndex: zoom, scrollSec: from, bpm: tempo } = frameRef.current
      const pxPerSec = ZOOM_LEVELS[zoom]
      ctx.save()
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.textBaseline = 'top'
      for (const line of gridLines(from, from + width / pxPerSec, tempo, gridBeats(tempo, pxPerSec))) {
        const x = Math.round((line.sec - from) * pxPerSec) + 0.5
        ctx.fillStyle = line.onBar ? TICK_BAR : TICK_BEAT
        ctx.fillRect(x, height - (line.onBar ? 8 : 5), 1, line.onBar ? 8 : 5)
        ctx.fillStyle = line.onBar ? TEXT_BAR : TEXT_BEAT
        ctx.fillText(barLabel(line), x + 3, 3)
      }
      ctx.restore()

      const headX = (useArrangement.getState().playheadSec - from) * pxPerSec
      if (headX >= 0 && headX <= width) {
        const x = Math.round(headX)
        ctx.fillStyle = PLAYHEAD
        ctx.fillRect(x, 0, 1, height)
        // A tab on the ruler, so the playhead can be picked out of the lanes
        // even where the audio behind it is bright.
        ctx.beginPath()
        ctx.moveTo(x - 4, 0)
        ctx.lineTo(x + 5, 0)
        ctx.lineTo(x + 0.5, 7)
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
    const state = useArrangement.getState()
    const at = state.scrollSec + (clientX - rect.left) / ZOOM_LEVELS[state.zoomIndex]
    state.seek(
      state.snap ? snapSec(at, state.bpm, gridBeats(state.bpm, ZOOM_LEVELS[state.zoomIndex])) : at
    )
  }, [])

  return (
    <div className="arrange-ruler">
      <div className="arrange-ruler__side" />
      <canvas
        className="arrange-ruler__canvas"
        ref={canvasRef}
        onPointerDown={(event) => seek(event.clientX)}
      />
      <div className="arrange-ruler__side" />
    </div>
  )
}
