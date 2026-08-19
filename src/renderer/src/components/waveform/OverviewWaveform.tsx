/// <reference types="vite/client" />
import { useCallback, useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { DeckId, HotCue, MemoryCue, WaveformData } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import type { Deck } from '@renderer/audio/Deck'
import { BAND_COLORS, BAND_COLORS_DIM } from '@renderer/core/constants'
import { clamp } from '@renderer/core/format'
import { useDecks } from '@renderer/state/useDecks'
import { useLibrary } from '@renderer/state/useLibrary'
import { useSettings } from '@renderer/state/useSettings'
import {
  OVERVIEW_CUE_STYLE,
  type BandColors,
  buildColumns,
  canvasNeedsResize,
  drawCueMarkers,
  drawPlayhead,
  drawWaveform,
  sizeCanvas
} from './waveformRender'
import './waveform.css'

/**
 * The whole track in one short strip, rekordbox's overview.
 *
 * The part already played is drawn in the dim band colours and the rest in the
 * bright ones, so the strip reads as a progress bar without needing one. The
 * two colourings are rasterised to offscreen canvases once per track and
 * blitted through a clip each frame: re-walking a five-minute envelope sixty
 * times a second would cost more than everything else in the app put together.
 *
 * Clicking or dragging is a needle drop — a seek, not a scrub. The playhead
 * comes from the engine inside a rAF loop, never from React state.
 */

export interface OverviewWaveformProps {
  deckId: DeckId
}

/**
 * Peaks are lifted slightly. A strict 0-1 mapping leaves the strip looking
 * half empty, because outside the loudest hits a bucket rarely reaches full
 * scale; the renderer clamps whatever this pushes past the top.
 */
const WAVE_GAIN = 1.2

/** Mono mode collapses the bands into the high band's near-white. */
const MONO_COLOR = BAND_COLORS.high
const MONO_COLOR_DIM = BAND_COLORS_DIM.high

/** Playhead movement below this is invisible, so the frame can be skipped. */
const MIN_PLAYHEAD_STEP_PX = 0.2

const NO_HOT_CUES: readonly HotCue[] = []
const NO_MEMORY_CUES: readonly MemoryCue[] = []

/** Everything a frame draws, kept in a ref so the rAF loop never re-subscribes. */
interface FrameState {
  deck: Deck | null
  waveform: WaveformData | null
  duration: number
  hotCues: readonly HotCue[]
  cuePoint: number | null
  memoryCues: readonly MemoryCue[]
  mono: boolean
}

/** The two static layers, and what they were last rasterised from. */
interface Layers {
  played: HTMLCanvasElement
  live: HTMLCanvasElement
  waveform: WaveformData | null
  duration: number
  width: number
  height: number
  dpr: number
  mono: boolean
}

export function OverviewWaveform({ deckId }: OverviewWaveformProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef({ width: 0, height: 0 })
  const layersRef = useRef<Layers | null>(null)
  const dirtyRef = useRef(true)
  const seekingRef = useRef(false)

  const status = useDecks((s) => s.decks[deckId].status)
  const waveform = useDecks((s) => s.decks[deckId].waveform)
  const trackId = useDecks((s) => s.decks[deckId].trackId)
  const track = useLibrary((s) => (trackId ? (s.trackById(trackId) ?? null) : null))
  const mono = useSettings((s) => s.waveformColorMode === 'mono')

  // The waveform's own bucket count is the most accurate length available; the
  // track's tag duration is only a fallback for the moments before it arrives.
  const duration =
    waveform && waveform.sampleRate > 0
      ? (waveform.bucketCount * waveform.bucketSize) / waveform.sampleRate
      : (track?.durationSec ?? 0)

  const frameRef = useRef<FrameState>({
    deck: null,
    waveform: null,
    duration: 0,
    hotCues: NO_HOT_CUES,
    cuePoint: null,
    memoryCues: NO_MEMORY_CUES,
    mono: false
  })

  // No dependency list: this is the one place the slow-changing store values
  // cross into the render loop, and it must run after every render.
  useEffect(() => {
    frameRef.current = {
      // `deck()` throws until the engine has initialised, which `ready` implies.
      deck: status === 'ready' ? AudioEngine.shared().deck(deckId) : null,
      waveform,
      duration,
      hotCues: track?.hotCues ?? NO_HOT_CUES,
      cuePoint: track?.cuePoint ?? null,
      memoryCues: track?.memoryCues ?? NO_MEMORY_CUES,
      mono
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
    let lastX = -1

    const frame = (): void => {
      raf = requestAnimationFrame(frame)
      const { width, height } = boxRef.current
      if (width <= 0 || height <= 0) return
      const dpr = window.devicePixelRatio || 1
      const state = frameRef.current

      const position = state.deck ? state.deck.positionSeconds() : 0
      const playX = state.duration > 0 ? clamp((position / state.duration) * width, 0, width) : 0
      const resized = canvasNeedsResize(canvas, width, height, dpr)
      if (!dirtyRef.current && !resized && Math.abs(playX - lastX) < MIN_PLAYHEAD_STEP_PX) return
      dirtyRef.current = false
      lastX = playX

      const layers = rasterise(layersRef.current, state, width, height, dpr)
      layersRef.current = layers

      const ctx = sizeCanvas(canvas, width, height, dpr)
      if (!ctx) return
      ctx.clearRect(0, 0, width, height)
      if (state.duration <= 0) return

      if (layers.waveform) {
        // Two clipped blits of full-size layers rather than a scaled partial
        // copy: the source and destination stay pixel-aligned at any dpr.
        if (playX > 0) {
          ctx.save()
          ctx.beginPath()
          ctx.rect(0, 0, playX, height)
          ctx.clip()
          ctx.drawImage(layers.played, 0, 0, width, height)
          ctx.restore()
        }
        if (playX < width) {
          ctx.save()
          ctx.beginPath()
          ctx.rect(playX, 0, width - playX, height)
          ctx.clip()
          ctx.drawImage(layers.live, 0, 0, width, height)
          ctx.restore()
        }
      }

      drawCueMarkers(
        ctx,
        state.hotCues,
        state.cuePoint,
        state.memoryCues,
        0,
        state.duration,
        width,
        height,
        OVERVIEW_CUE_STYLE
      )
      drawPlayhead(ctx, playX, height)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  const seekTo = useCallback(
    (clientX: number): void => {
      const canvas = canvasRef.current
      const { duration: total } = frameRef.current
      if (!canvas || total <= 0) return
      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0) return
      useDecks.getState().seek(deckId, clamp((clientX - rect.left) / rect.width, 0, 1) * total)
    },
    [deckId]
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      if (event.button !== 0) return
      event.currentTarget.setPointerCapture(event.pointerId)
      seekingRef.current = true
      seekTo(event.clientX)
    },
    [seekTo]
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      if (seekingRef.current) seekTo(event.clientX)
    },
    [seekTo]
  )

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!seekingRef.current) return
    seekingRef.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  return (
    <div className="waveform-overview">
      <canvas
        ref={canvasRef}
        className="waveform-overview__canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
      />
    </div>
  )
}

/**
 * Re-rasterise the dim and bright layers when anything they depend on has
 * changed, otherwise hand back the ones already drawn.
 */
function rasterise(
  current: Layers | null,
  state: FrameState,
  width: number,
  height: number,
  dpr: number
): Layers {
  const layers: Layers = current ?? {
    played: document.createElement('canvas'),
    live: document.createElement('canvas'),
    waveform: null,
    duration: 0,
    width: 0,
    height: 0,
    dpr: 0,
    mono: false
  }
  const unchanged =
    current !== null &&
    layers.waveform === state.waveform &&
    layers.duration === state.duration &&
    layers.width === width &&
    layers.height === height &&
    layers.dpr === dpr &&
    layers.mono === state.mono
  if (unchanged) return layers

  layers.waveform = state.waveform && state.duration > 0 ? state.waveform : null
  layers.duration = state.duration
  layers.width = width
  layers.height = height
  layers.dpr = dpr
  layers.mono = state.mono

  const cols = layers.waveform
    ? buildColumns(layers.waveform, 0, state.duration, width, layers.waveform.sampleRate)
    : null
  const passes: ReadonlyArray<[HTMLCanvasElement, BandColors, string]> = [
    [layers.played, BAND_COLORS_DIM, MONO_COLOR_DIM],
    [layers.live, BAND_COLORS, MONO_COLOR]
  ]
  for (const [canvas, colors, monoColor] of passes) {
    const ctx = sizeCanvas(canvas, width, height, dpr)
    if (!ctx) continue
    // sizeCanvas only wipes the canvas when its dimensions change, so a
    // re-raster at the same size has to clear the old track for itself.
    ctx.clearRect(0, 0, width, height)
    if (cols) {
      drawWaveform(ctx, cols, {
        height,
        colors,
        mono: state.mono ? monoColor : undefined,
        gain: WAVE_GAIN
      })
    }
  }
  return layers
}

export default OverviewWaveform
