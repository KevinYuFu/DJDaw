/// <reference types="vite/client" />
import { useCallback, useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { Clip } from '@shared/clips'
import { clipAt, dropIndex, timelineDuration } from '@shared/clips'
import { beginSlide, slideClips } from '@renderer/components/waveform/clipSlide'
import type { Slide } from '@renderer/components/waveform/clipSlide'
import type { DeckId, HotCue, MemoryCue, WaveformData } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import type { Deck } from '@renderer/audio/Deck'
import { BAND_COLORS, BAND_COLORS_DIM } from '@renderer/core/constants'
import { clamp } from '@renderer/core/format'
import { useDecks } from '@renderer/state/useDecks'
import { useLibrary } from '@renderer/state/useLibrary'
import { useSettings } from '@renderer/state/useSettings'
import {
  OVERVIEW_CLIP_STYLE,
  OVERVIEW_CUE_STYLE,
  OVERVIEW_LOCATOR_STYLE,
  type BandColors,
  buildClipColumns,
  buildColumns,
  canvasNeedsResize,
  drawClipBands,
  drawClipEdges,
  drawClipGhost,
  drawClipHighlight,
  drawCueMarkers,
  drawLocators,
  drawPlayhead,
  drawWaveform,
  sizeCanvas
} from './waveformRender'
import './waveform.css'

/**
 * The MACRO view: the whole track in one short strip, rekordbox's overview.
 *
 * The part already played is drawn in the dim band colours and the rest in the
 * bright ones, so the strip reads as a progress bar without needing one. The
 * two colourings are rasterised to offscreen canvases once per track and
 * blitted through a clip each frame: re-walking a five-minute envelope sixty
 * times a second would cost more than everything else in the app put together.
 *
 * Clicking or dragging is a needle drop — a seek, not a scrub. With
 * `draggableClips` on, a press that lands on a piece of a cut-up row drags
 * that piece instead. The playhead comes from the engine inside a rAF loop,
 * never from React state.
 */

export interface OverviewWaveformProps {
  deckId: DeckId
  /**
   * Let a press drag the piece under it to a new place on the row, and draw
   * the pieces the row is made of. On in the editing view, where reordering
   * the chunks is the job; off on a performance deck, which is one whole-track
   * clip that has nowhere to go but away from zero.
   */
  draggableClips?: boolean
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

/** Opacity of the already-played half in RGB mode. */
const RGB_DIM = 0.42

/** Playhead movement below this is invisible, so the frame can be skipped. */
const MIN_PLAYHEAD_STEP_PX = 0.2

/** Pointer travel below this is a click, above it a clip drag. */
const DRAG_SLOP_PX = 3

const NO_CLIPS: readonly Clip[] = []
const NO_HOT_CUES: readonly HotCue[] = []
const NO_LOCATORS: readonly MemoryCue[] = []

/** Everything a frame draws, kept in a ref so the rAF loop never re-subscribes. */
interface FrameState {
  deck: Deck | null
  waveform: WaveformData | null
  duration: number
  hotCues: readonly HotCue[]
  cuePoint: number | null
  /** Locators. Stored on the track as `memoryCues`, the rekordbox name. */
  locators: readonly MemoryCue[]
  /** The pieces the row is made of, in timeline order. Empty when not an edit row. */
  clips: readonly Clip[]
  selectedClipId: string | null
  /** Whether this strip draws its pieces and lets them be dragged. */
  draggable: boolean
  mono: boolean
  rgb: boolean
}

/** The two static layers, and what they were last rasterised from. */
interface Layers {
  played: HTMLCanvasElement
  live: HTMLCanvasElement
  waveform: WaveformData | null
  clips: readonly Clip[]
  duration: number
  width: number
  height: number
  dpr: number
  mono: boolean
  rgb: boolean
}

/** A needle drop: it began on empty space, or on a strip that does not drag. */
interface SeekGesture {
  kind: 'seek'
  pointerId: number
}

/**
 * A press that landed on a piece. Until it has travelled {@link DRAG_SLOP_PX}
 * it is still a needle drop, so nothing is committed and nothing has moved.
 */
interface ClipGesture {
  kind: 'clip'
  pointerId: number
  startX: number
  clip: Clip
  /** Strip geometry at press time, so a resize mid-drag cannot skew the maths. */
  width: number
  duration: number
  dragging: boolean
  /** Escape gives the drag up but keeps the gesture, so the release can tidy up. */
  cancelled: boolean
  /** Where the piece sat before any of this, to put it back on Escape. */
  fromIndex: number
  /** Where it sits now, so the row is only rearranged when that changes. */
  atIndex: number
}

type Gesture = SeekGesture | ClipGesture

/** Where a dragged piece would land if it were dropped now. */
interface Ghost {
  clipId: string
  startSec: number
  durationSec: number
}


export function OverviewWaveform({
  deckId,
  draggableClips = false
}: OverviewWaveformProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef({ width: 0, height: 0 })
  const layersRef = useRef<Layers | null>(null)
  const dirtyRef = useRef(true)
  const gestureRef = useRef<Gesture | null>(null)
  const slideRef = useRef<Slide | null>(null)
  const ghostRef = useRef<Ghost | null>(null)

  const status = useDecks((s) => s.decks[deckId].status)
  const waveform = useDecks((s) => s.decks[deckId].waveform)
  const trackId = useDecks((s) => s.decks[deckId].trackId)
  const clips = useDecks((s) => s.decks[deckId].clips)
  const selectedClipId = useDecks((s) => s.decks[deckId].selectedClipId)
  const track = useLibrary((s) => (trackId ? (s.trackById(trackId) ?? null) : null))
  const mono = useSettings((s) => s.waveformColorMode === 'mono')
  const rgb = useSettings((s) => s.waveformColorMode === 'rgb')

  // The waveform's own bucket count is the most accurate length available; the
  // track's tag duration is only a fallback for the moments before it arrives.
  const sourceDuration =
    waveform && waveform.sampleRate > 0
      ? (waveform.bucketCount * waveform.bucketSize) / waveform.sampleRate
      : (track?.durationSec ?? 0)

  // An edit row is a timeline, not a file: a piece dragged past the end of the
  // audio makes the row longer than the track it came from, and the strip has
  // to keep showing all of it.
  const duration = draggableClips
    ? Math.max(sourceDuration, timelineDuration(clips))
    : sourceDuration

  const frameRef = useRef<FrameState>({
    deck: null,
    waveform: null,
    duration: 0,
    hotCues: NO_HOT_CUES,
    cuePoint: null,
    locators: NO_LOCATORS,
    clips: NO_CLIPS,
    selectedClipId: null,
    draggable: false,
    mono: false,
    rgb: false
  })

  // No dependency list: this is the one place the slow-changing store values
  // cross into the render loop, and it must run after every render.
  useEffect(() => {
    const before = frameRef.current.clips
    const nextClips = draggableClips ? clips : NO_CLIPS
    if (before !== nextClips) {
      const slide = beginSlide(before, nextClips, performance.now())
      if (slide) slideRef.current = slide
    }
    frameRef.current = {
      // `deck()` throws until the engine has initialised, which `ready` implies.
      deck: status === 'ready' ? AudioEngine.shared().deck(deckId) : null,
      waveform,
      duration,
      hotCues: track?.hotCues ?? NO_HOT_CUES,
      cuePoint: track?.cuePoint ?? null,
      locators: track?.memoryCues ?? NO_LOCATORS,
      clips: draggableClips ? clips : NO_CLIPS,
      selectedClipId: draggableClips ? selectedClipId : null,
      draggable: draggableClips,
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
    let lastX = -1

    const frame = (): void => {
      raf = requestAnimationFrame(frame)
      const { width, height } = boxRef.current
      if (width <= 0 || height <= 0) return
      const dpr = window.devicePixelRatio || 1
      const settled = frameRef.current
      let state = settled
      if (slideRef.current) {
        const { clips: sliding, done } = slideClips(
          settled.clips,
          slideRef.current,
          performance.now()
        )
        if (done) slideRef.current = null
        else {
          state = { ...settled, clips: sliding }
          dirtyRef.current = true
        }
      }
      const ghost = ghostRef.current

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

      // Under the waveform, as the MICRO view draws it, so the envelope stays
      // the brightest thing on the strip. Mid-drag it marks the piece being
      // moved, which is what gives the eye both ends of the move at once.
      if (state.draggable) {
        drawClipBands(ctx, state.clips, 0, state.duration, width, height, OVERVIEW_CLIP_STYLE)
        drawClipHighlight(
          ctx,
          state.clips,
          ghost ? ghost.clipId : state.selectedClipId,
          0,
          state.duration,
          width,
          height,
          OVERVIEW_CLIP_STYLE
        )
      }

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

      // The MACRO view is the whole track in 38 px, so locators are a tab and
      // a line here; the names belong to the MICRO view, which has the room.
      drawLocators(ctx, state.locators, 0, state.duration, width, height, OVERVIEW_LOCATOR_STYLE)
      // Hairlines where the row was cut. An uncut row draws none of them, so a
      // freshly loaded edit row looks exactly like a performance deck's strip.
      if (state.draggable) {
        drawClipEdges(
          ctx,
          state.clips,
          state.selectedClipId,
          0,
          state.duration,
          width,
          height,
          OVERVIEW_CLIP_STYLE
        )
      }
      // a line here; the names belong to the MICRO view, which has the room.
      drawCueMarkers(
        ctx,
        state.hotCues,
        state.cuePoint,
        0,
        state.duration,
        width,
        height,
        OVERVIEW_CUE_STYLE
      )
      if (ghost) {
        drawClipGhost(ctx, ghost.startSec, ghost.durationSec, 0, state.duration, width, height)
      }
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

  /** Where the dragged piece would start if the pointer let go at `clientX`. */
  const dropTarget = useCallback(
    (gesture: ClipGesture, clientX: number): number => {
      const raw =
        gesture.clip.startSec + ((clientX - gesture.startX) * gesture.duration) / gesture.width
      // Keep the piece on the strip: past either edge there is nothing to draw
      // the ghost against and nothing to aim at.
      // Rearrange the row as the hand crosses each neighbour, not on release,
      // and let the ghost follow the hand rather than the slot.
      const room = Math.max(0, gesture.duration - gesture.clip.durationSec)
      const at = clamp(raw, 0, room)
      const clips = useDecks.getState().decks[deckId].clips
      const to = dropIndex(clips, gesture.clip.id, at)
      if (to !== gesture.atIndex) {
        gesture.atIndex = to
        useDecks.getState().reorderClipTo(deckId, gesture.clip.id, to)
      }
      return at
    },
    [deckId]
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      if (event.button !== 0) return
      const canvas = event.currentTarget
      canvas.setPointerCapture(event.pointerId)
      const state = frameRef.current
      const rect = canvas.getBoundingClientRect()
      const grabbed =
        state.draggable && rect.width > 0 && state.duration > 0
          ? clipAt(
              state.clips,
              clamp((event.clientX - rect.left) / rect.width, 0, 1) * state.duration
            )
          : null

      if (!grabbed) {
        // Empty space, or a performance strip: the press is a needle drop and
        // seeks straight away, exactly as it always has.
        gestureRef.current = { kind: 'seek', pointerId: event.pointerId }
        seekTo(event.clientX)
        return
      }

      // On a piece, the seek waits until the gesture has decided what it is.
      // Seeking now would jog the playhead every time a chunk is picked up.
      const index = state.clips.findIndex((clip) => clip.id === grabbed.id)
      gestureRef.current = {
        kind: 'clip',
        pointerId: event.pointerId,
        startX: event.clientX,
        clip: grabbed,
        width: rect.width,
        duration: state.duration,
        dragging: false,
        cancelled: false,
        fromIndex: index,
        atIndex: index
      }
    },
    [seekTo]
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      const gesture = gestureRef.current
      if (!gesture || gesture.pointerId !== event.pointerId) return
      if (gesture.kind === 'seek') {
        seekTo(event.clientX)
        return
      }
      if (gesture.cancelled) return
      if (!gesture.dragging) {
        if (Math.abs(event.clientX - gesture.startX) <= DRAG_SLOP_PX) return
        gesture.dragging = true
      }
      ghostRef.current = {
        clipId: gesture.clip.id,
        startSec: dropTarget(gesture, event.clientX),
        durationSec: gesture.clip.durationSec
      }
      dirtyRef.current = true
    },
    [dropTarget, seekTo]
  )

  // pointerup, pointercancel and lostpointercapture all mean the gesture is
  // over. Capture puts the first two here wherever the pointer has gone; the
  // third catches a capture torn away without either. Whichever arrives first
  // clears the ref, so the rest are no-ops — a drag that never ended would
  // leave the row stuck mid-move.
  const endGesture = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      const gesture = gestureRef.current
      if (!gesture || gesture.pointerId !== event.pointerId) return
      gestureRef.current = null
      ghostRef.current = null
      dirtyRef.current = true
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }

      if (gesture.kind === 'seek' || gesture.cancelled) return
      // A press that went nowhere is still a needle drop. Picking pieces up
      // must not cost the strip its click-to-seek.
      if (!gesture.dragging) {
        seekTo(event.clientX)
        return
      }
      // The row has already been rearranged all the way along, so a release has
      // nothing left to commit.
    },
    [deckId, seekTo]
  )

  // Escape abandons a drag. The gesture stays until the pointer comes up, so
  // the capture is still released there and the same press cannot pick the
  // drag back up halfway through.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const gesture = gestureRef.current
      if (!gesture || gesture.kind !== 'clip' || !gesture.dragging || gesture.cancelled) return
      gesture.cancelled = true
      // Put it back where it was picked up, since the row has been rearranging
      // all the way along.
      useDecks.getState().reorderClipTo(deckId, gesture.clip.id, gesture.fromIndex)
      gesture.atIndex = gesture.fromIndex
      ghostRef.current = null
      dirtyRef.current = true
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deckId])

  return (
    <div className="waveform-overview">
      <canvas
        ref={canvasRef}
        className="waveform-overview__canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onLostPointerCapture={endGesture}
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
    clips: NO_CLIPS,
    duration: 0,
    width: 0,
    height: 0,
    dpr: 0,
    mono: false,
    rgb: false
  }
  const unchanged =
    current !== null &&
    layers.waveform === state.waveform &&
    layers.clips === state.clips &&
    layers.duration === state.duration &&
    layers.width === width &&
    layers.height === height &&
    layers.dpr === dpr &&
    layers.mono === state.mono &&
    layers.rgb === state.rgb
  if (unchanged) return layers

  layers.waveform = state.waveform && state.duration > 0 ? state.waveform : null
  layers.clips = state.clips
  layers.duration = state.duration
  layers.width = width
  layers.height = height
  layers.dpr = dpr
  layers.mono = state.mono
  layers.rgb = state.rgb

  // Once a row is cut, timeline seconds stop matching source seconds, so the
  // pieces are the only honest way to lay the envelope out. A row with no
  // pieces yet — a deck still loading — falls back to the plain whole-file
  // walk, which is what an uncut row comes out as anyway.
  const cols = !layers.waveform
    ? null
    : layers.clips.length > 0
      ? buildClipColumns(
          layers.waveform,
          layers.clips,
          0,
          state.duration,
          width * dpr,
          layers.waveform.sampleRate
        )
      : buildColumns(layers.waveform, 0, state.duration, width * dpr, layers.waveform.sampleRate)
  const passes: ReadonlyArray<[HTMLCanvasElement, BandColors, string, number]> = [
    [layers.played, BAND_COLORS_DIM, MONO_COLOR_DIM, RGB_DIM],
    [layers.live, BAND_COLORS, MONO_COLOR, 1]
  ]
  for (const [canvas, colors, monoColor, dim] of passes) {
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
        rgb: state.rgb,
        dim,
        gain: WAVE_GAIN,
        subpixel: dpr
      })
    }
  }
  return layers
}

export default OverviewWaveform
