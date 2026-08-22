/// <reference types="vite/client" />
import { useCallback, useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { Clip } from '@shared/clips'
import { clipAt, timelineDuration } from '@shared/clips'
import { beginSlide, slideClips } from '@renderer/components/waveform/clipSlide'
import type { Slide } from '@renderer/components/waveform/clipSlide'
import type { DeckId, HotCue, MemoryCue, WaveformData } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import type { Deck } from '@renderer/audio/Deck'
import { BAND_COLORS, BAND_COLORS_DIM } from '@renderer/core/constants'
import { clamp } from '@renderer/core/format'
import { useDecks, waveForSource } from '@renderer/state/useDecks'
import { registerDropZone, zoneAt } from './dropZones'
import {
  aimInRow,
  clipDrag,
  dropLineFor,
  newDragRowMemo,
  rowForDrag,
  rowWithout,
  setClipDrag
} from './clipDrag'
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
  disabledMasks,
  DISABLED_FILTER,
  drawClipHighlight,
  drawCueMarkers,
  drawDropMarker,
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

/** Pointer travel below this, in either direction, is a click not a drag. */
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
  startY: number
  clip: Clip
  /** Strip geometry at press time, so a resize mid-drag cannot skew the maths. */
  width: number
  height: number
  duration: number
  /** Where in the piece it was taken hold of, so the ghost does not jump. */
  grabDx: number
  dragging: boolean
  /** Escape gives the drag up but keeps the gesture, so the release can tidy up. */
  cancelled: boolean
}

type Gesture = SeekGesture | ClipGesture



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
  const gapRef = useRef(newDragRowMemo())
  const shownRef = useRef<readonly Clip[]>(NO_CLIPS)

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

  // An edit row is a timeline, not a file: it is as long as the pieces on it,
  // which is what the engine plays and clamps against. A row built out of one
  // dropped piece is that piece long, not as long as the file it came from.
  const rowDuration = timelineDuration(clips)
  const duration = draggableClips && rowDuration > 0 ? rowDuration : sourceDuration

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

  // A strip that goes away mid-drag takes the drag with it: left published, it
  // would keep every other row showing a drop that is never coming.
  useEffect(() => {
    if (!draggableClips) return
    return () => {
      const held = clipDrag()
      if (held && held.fromDeck === deckId) setClipDrag(null)
    }
  }, [deckId, draggableClips])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !draggableClips) return
    return registerDropZone({
      deck: deckId,
      canvas,
      timeAt: (clientX) => {
        const rect = canvas.getBoundingClientRect()
        const { duration: total } = frameRef.current
        if (rect.width <= 0 || total <= 0) return 0
        return clamp((clientX - rect.left) / rect.width, 0, 1) * total
      }
    })
  }, [deckId, draggableClips])

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
    let lastMark = -1

    const frame = (): void => {
      raf = requestAnimationFrame(frame)
      const { width, height } = boxRef.current
      if (width <= 0 || height <= 0) return
      const dpr = window.devicePixelRatio || 1
      const settled = frameRef.current
      const now = performance.now()

      // Room for a piece held over this row from another one. It is drawn, not
      // stored: nothing about the row changes until the piece is let go.
      const lineSec = settled.draggable ? dropLineFor(deckId) : null
      const target = settled.draggable
        ? rowForDrag(gapRef.current, deckId, settled.clips)
        : settled.clips
      // Every movement a row makes goes through here: reordering, closing a
      // hole, opening room for a piece. Starting from where the pieces are
      // being drawn rather than where they were headed keeps a slide that is
      // interrupted by another from jumping.
      if (target !== shownRef.current) {
        const seen = slideRef.current
          ? slideClips(shownRef.current, slideRef.current, now).clips
          : shownRef.current
        slideRef.current = beginSlide(seen, target, now)
        shownRef.current = target
        dirtyRef.current = true
      }
      let drawn = target
      if (slideRef.current) {
        const { clips: sliding, done } = slideClips(target, slideRef.current, now)
        // The frame a slide finishes on is the first one showing where the
        // pieces actually are, so it has to be drawn like any other.
        dirtyRef.current = true
        if (done) slideRef.current = null
        else drawn = sliding
      }
      const state = drawn === settled.clips ? settled : { ...settled, clips: drawn }

      const position = state.deck ? state.deck.positionSeconds() : 0
      const playX = state.duration > 0 ? clamp((position / state.duration) * width, 0, width) : 0
      const markSec = lineSec ?? -1
      if (markSec !== lastMark) dirtyRef.current = true
      lastMark = markSec

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
      // the brightest thing on the strip.
      if (state.draggable) {
        drawClipBands(ctx, state.clips, 0, state.duration, width, height, OVERVIEW_CLIP_STYLE)
        drawClipHighlight(
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

      if (layers.waveform) {
        // Two clipped blits of full-size layers rather than a scaled partial
        // copy: the source and destination stay pixel-aligned at any dpr.
        const blit = (): void => {
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
        // Switched-off pieces are laid down in a second pass with the colour
        // filtered out, so their shape stays but they read as off.
        const masks = state.draggable
          ? disabledMasks(state.clips, 0, state.duration, width, height)
          : null
        if (!masks) blit()
        else {
          ctx.save()
          ctx.clip(masks.on)
          blit()
          ctx.restore()
          ctx.save()
          ctx.clip(masks.off)
          ctx.filter = DISABLED_FILTER
          blit()
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
      if (lineSec !== null) drawDropMarker(ctx, lineSec, 0, state.duration, width, height)
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
      drawPlayhead(ctx, playX, height)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [deckId])

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

  /**
   * Point the drag at whatever is under the hand, and say so.
   *
   * The same answer whether the hand is over the row the piece came from or
   * another one: the piece comes out of the order, and the row it is over says
   * where it would go back in. Nothing is written until the hand opens.
   */
  const aim = useCallback(
    (gesture: ClipGesture, clientX: number, clientY: number): void => {
      const zone = zoneAt(clientX, clientY)
      const decks = useDecks.getState().decks
      const ghost = {
        clip: gesture.clip,
        x: clientX - gesture.grabDx,
        y: clientY - gesture.height / 2,
        width: (gesture.clip.durationSec / gesture.duration) * gesture.width,
        height: gesture.height
      }
      if (!zone) {
        setClipDrag({ fromDeck: deckId, toDeck: null, index: 0, holeId: null, atSec: 0, ...ghost })
        return
      }
      const row =
        zone.deck === deckId
          ? rowWithout(decks[deckId].clips, gesture.clip.id)
          : decks[zone.deck].clips
      const at = aimInRow(row, gesture.clip, zone.timeAt(clientX))
      setClipDrag({ fromDeck: deckId, toDeck: zone.deck, ...at, ...ghost })
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
      useDecks.getState().selectClip(deckId, grabbed.id)
      const perSec = rect.width / state.duration
      gestureRef.current = {
        kind: 'clip',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        clip: grabbed,
        width: rect.width,
        height: rect.height,
        duration: state.duration,
        grabDx: event.clientX - (rect.left + grabbed.startSec * perSec),
        dragging: false,
        cancelled: false
      }
    },
    [deckId, seekTo]
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
        // Either direction: a piece taken to another row moves mostly down.
        if (
          Math.abs(event.clientX - gesture.startX) <= DRAG_SLOP_PX &&
          Math.abs(event.clientY - gesture.startY) <= DRAG_SLOP_PX
        ) {
          return
        }
        gesture.dragging = true
      }
      aim(gesture, event.clientX, event.clientY)
      dirtyRef.current = true
    },
    [aim, seekTo]
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
      dirtyRef.current = true
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }

      const drag = gesture.kind === 'clip' ? clipDrag() : null
      if (gesture.kind === 'clip') setClipDrag(null)
      if (gesture.kind === 'seek' || gesture.cancelled) return
      // A press that went nowhere is still a needle drop. Picking pieces up
      // must not cost the strip its click-to-seek.
      if (!gesture.dragging) {
        seekTo(event.clientX)
        return
      }
      // Where the drag was pointing is where it lands, which is what the rows
      // have been showing all the way along.
      if (drag && drag.toDeck) {
        useDecks.getState().dropClip(deckId, gesture.clip.id, drag.toDeck, {
          index: drag.index,
          holeId: drag.holeId,
          atSec: drag.atSec
        })
      }
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
      setClipDrag(null)
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
          layers.waveform.sampleRate,
          null,
          undefined,
          waveForSource
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
