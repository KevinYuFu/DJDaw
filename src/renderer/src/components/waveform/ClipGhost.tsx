import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { useDecks, waveForSource } from '@renderer/state/useDecks'
import { BAND_COLORS } from '@renderer/core/constants'
import { useSettings } from '@renderer/state/useSettings'
import { buildClipColumns, drawWaveform, sizeCanvas } from './waveformRender'
import type { ClipDrag } from './clipDrag'
import { clipDrag, subscribeClipDrag } from './clipDrag'
import './waveform.css'

/**
 * The piece being carried, drawn under the hand.
 *
 * A shadow of the piece itself rather than an outline: what is being moved has
 * to be recognisable while the rows underneath rearrange around it. It floats
 * above everything and is not part of any row, so it can cross between them.
 */

/** Widest the shadow is drawn, so a long piece does not cover the window. */
const MAX_WIDTH_PX = 420

/** Narrowest, so a piece of a second is still something to hold on to. */
const MIN_WIDTH_PX = 24

export function ClipGhost(): ReactElement {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawnRef = useRef<string>('')
  const mono = useSettings((s) => s.waveformColorMode === 'mono')
  const rgb = useSettings((s) => s.waveformColorMode === 'rgb')

  useEffect(() => {
    const paint = (drag: ClipDrag | null): void => {
      const box = boxRef.current
      const canvas = canvasRef.current
      if (!box || !canvas) return
      if (!drag) {
        box.style.display = 'none'
        drawnRef.current = ''
        return
      }

      const width = Math.max(MIN_WIDTH_PX, Math.min(MAX_WIDTH_PX, Math.round(drag.width)))
      const height = Math.max(1, Math.round(drag.height))
      // Hung off the hand by the fraction it took hold of, so the same spot on
      // the piece stays under the pointer however wide it is drawn.
      const left = Math.round(drag.x - drag.grab * width)
      const top = Math.round(drag.y - height / 2)
      box.style.display = 'block'
      box.style.width = `${width}px`
      box.style.height = `${height}px`
      box.style.transform = `translate(${left}px, ${top}px)`

      // The shape only has to be drawn when the piece or its size changes; the
      // rest of the drag just moves it.
      const key = `${drag.clip.id}|${width}|${height}|${mono}|${rgb}`
      if (key === drawnRef.current) return
      drawnRef.current = key

      const dpr = window.devicePixelRatio || 1
      const ctx = sizeCanvas(canvas, width, height, dpr)
      if (!ctx) return
      ctx.clearRect(0, 0, width, height)

      const deck = useDecks.getState().decks[drag.fromDeck]
      const wave = (drag.clip.sourceId ? waveForSource(drag.clip.sourceId) : null) ?? deck.waveform
      if (!wave || drag.clip.silent) return
      const laid = [{ ...drag.clip, startSec: 0 }]
      const cols = buildClipColumns(
        wave,
        laid,
        0,
        drag.clip.durationSec,
        width * dpr,
        wave.sampleRate,
        null,
        undefined,
        waveForSource
      )
      drawWaveform(ctx, cols, {
        height,
        colors: BAND_COLORS,
        mono: mono ? BAND_COLORS.high : undefined,
        rgb,
        subpixel: dpr
      })
    }

    paint(clipDrag())
    return subscribeClipDrag(paint)
  }, [mono, rgb])

  return (
    <div className="clip-ghost" ref={boxRef}>
      <canvas className="clip-ghost__canvas" ref={canvasRef} />
    </div>
  )
}
