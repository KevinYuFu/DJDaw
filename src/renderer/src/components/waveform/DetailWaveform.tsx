/// <reference types="vite/client" />
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement, WheelEvent as ReactWheelEvent } from 'react'
import type { Clip } from '@shared/clips'
import type { ColumnExtents } from '@renderer/components/waveform/waveformRender'
import { clipAt } from '@shared/clips'
import { beginSlide, slideClips } from '@renderer/components/waveform/clipSlide'
import type { Slide } from '@renderer/components/waveform/clipSlide'
import type { BeatGrid, DeckId, HotCue, MemoryCue, WaveformData } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import type { Deck } from '@renderer/audio/Deck'
import { BAND_COLORS, WAVE_ZOOM_LEVELS } from '@renderer/core/constants'
import { clamp } from '@renderer/core/format'
import { audioForSource, useDecks, waveForSource } from '@renderer/state/useDecks'
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
  DETAIL_CUE_STYLE,
  DETAIL_LOCATOR_STYLE,
  type WaveformColumns,
  buildClipColumns,
  buildClipExtents,
  canvasNeedsResize,
  drawBeatGrid,
  drawClipBands,
  drawClipEdges,
  DEFAULT_CLIP_STYLE,
  drawClipHighlight,
  disabledMasks,
  DISABLED_FILTER,
  drawCueMarkers,
  drawDropMarker,
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
const WAVE_GAIN = 0.8

/**
 * Widest column, in source frames, still drawn from the samples themselves.
 * Past this the band envelope already aggregates enough to look the same and
 * the scan stops being free.
 */
const MAX_SAMPLES_PER_COLUMN = 600

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

/**
 * A press on a piece's handle that has not travelled yet. Below
 * {@link CLICK_SLOP_PX} it is still a click, so nothing has moved and the
 * release can still select instead.
 */
interface HeldClip {
  pointerId: number
  startX: number
  startY: number
  clip: Clip
  /** Geometry at press time, so a resize mid-drag cannot skew the maths. */
  width: number
  height: number
  span: number
  /** Where in the piece it was taken hold of, so the ghost does not jump. */
  grabDx: number
  dragging: boolean
  /** Escape gives the drag up but keeps the gesture, so the release tidies up. */
  cancelled: boolean
}

/**
 * The audio a piece from another row plays, as plain channel arrays.
 *
 * Cached: `getChannelData` is not free to call sixty times a second, and a row
 * can be carrying pieces from several files at once.
 */
const foreignChannels = new Map<string, readonly Float32Array[]>()
function channelsForSource(sourceId: string): readonly Float32Array[] | null {
  const cached = foreignChannels.get(sourceId)
  if (cached) return cached
  const buffer = audioForSource(sourceId)
  if (!buffer) return null
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))
  foreignChannels.set(sourceId, channels)
  return channels
}

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
  /** Decoded channels, for reading the true peak of a column. */
  channels: readonly Float32Array[] | null
  mono: boolean
  rgb: boolean
}

export function DetailWaveform({ deckId, selectClips = false }: DetailWaveformProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef({ width: 0, height: 0 })
  const extentsRef = useRef<ColumnExtents | null>(null)
  const clipDragRef = useRef<HeldClip | null>(null)
  const slideRef = useRef<Slide | null>(null)
  const gapRef = useRef(newDragRowMemo())
  const shownRef = useRef<readonly Clip[]>(NO_CLIPS)
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
  const buffer = useDecks((s) => s.decks[deckId].buffer)
  // Held as plain arrays so the draw loop never touches the AudioBuffer, whose
  // getChannelData is not free to call sixty times a second.
  const channels = useMemo(() => {
    if (!buffer) return null
    const out: Float32Array[] = []
    for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c))
    return out
  }, [buffer])

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
    channels: null,
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
      channels,
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

  // A strip that goes away mid-drag takes the drag with it: left published, it
  // would keep every other row showing a drop that is never coming.
  useEffect(() => {
    if (!selectClips) return
    return () => {
      const held = clipDrag()
      if (held && held.fromDeck === deckId) setClipDrag(null)
    }
  }, [deckId, selectClips])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !selectClips) return
    return registerDropZone({
      deck: deckId,
      canvas,
      timeAt: (clientX) => {
        const rect = canvas.getBoundingClientRect()
        const { width } = boxRef.current
        const { deck, span } = frameRef.current
        if (!deck || width <= 0) return 0
        return deck.positionSeconds() + (clientX - rect.left - width / 2) * (span / width)
      }
    })
  }, [deckId, selectClips])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0
    let lastPosition = Number.NaN
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
      const lineSec = selectClips ? dropLineFor(deckId) : null
      const target = selectClips
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
      const pxPerSecond = width / state.span
      const markSec = lineSec ?? -1
      if (markSec !== lastMark) dirtyRef.current = true
      lastMark = markSec

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

      drawClipBands(ctx, state.clips, from, to, width, height)
      drawClipHighlight(ctx, state.clips, state.selectedClipId, from, to, width, height)

      if (state.waveform) {
        // One column per device pixel, not per CSS pixel: on a retina panel
        // that is twice the detail, and it is what keeps a drum hit a spike.
        const columns = Math.max(1, Math.round(width * dpr))
        const columnSec = state.span / columns

        // The strip scrolls a whole column at a time, and a column is a whole
        // device pixel.
        //
        // Both halves of that matter. Laying the columns out from the playhead
        // would give each one a different slice of audio every frame and its
        // height would change under it. Landing them on a fraction of a pixel
        // would blend every bar across two pixels by an amount that changes
        // every frame, and the colour would flicker. Either way the strip
        // pulses instead of moving.
        const grid = { index: Math.round(from / columnSec), columnSec }
        const gridFrom = grid.index * columnSec
        const gridTo = gridFrom + columns * columnSec

        // Per clip, not per pixel: each piece draws the slice of the file its
        // `sourceOffsetSec` points at, so a cut row shows what it plays and a
        // deleted piece leaves the background bare.
        const cols = buildClipColumns(
          state.waveform,
          state.clips,
          gridFrom,
          gridTo,
          columns,
          state.waveform.sampleRate,
          columnsRef.current,
          grid,
          waveForSource
        )
        columnsRef.current = cols
        // Reading samples is only worth it while a column covers few enough of
        // them to have a shape of its own; zoomed out it costs milliseconds and
        // looks identical.
        const perColumn = columnSec * state.waveform.sampleRate
        const extents =
          state.channels && perColumn <= MAX_SAMPLES_PER_COLUMN
            ? buildClipExtents(
                state.channels,
                state.clips,
                gridFrom,
                gridTo,
                columns,
                state.waveform.sampleRate,
                extentsRef.current,
                grid,
                channelsForSource
              )
            : null
        extentsRef.current = extents
        const paint = (): void =>
          drawWaveform(ctx, cols, {
            height,
            colors: BAND_COLORS,
            mono: state.mono ? MONO_COLOR : undefined,
            rgb: state.rgb,
            gain: WAVE_GAIN,
            subpixel: dpr,
            extents
          })
        // Switched-off pieces are laid down in a second pass with the colour
        // filtered out, so their shape stays but they read as off.
        const masks = selectClips ? disabledMasks(state.clips, from, to, width, height) : null
        if (!masks) paint()
        else {
          ctx.save()
          ctx.clip(masks.on)
          paint()
          ctx.restore()
          ctx.save()
          ctx.clip(masks.off)
          ctx.filter = DISABLED_FILTER
          paint()
          ctx.restore()
        }
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
      if (lineSec !== null) drawDropMarker(ctx, lineSec, from, to, width, height)
      drawPlayhead(ctx, width / 2, height)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [deckId, selectClips])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      if (event.button !== 0) return
      const state = frameRef.current
      const { deck } = state
      if (!deck) return
      const rect = event.currentTarget.getBoundingClientRect()
      const { width } = boxRef.current

      // A press on a piece's handle picks the piece up. Anywhere else on the
      // row is a scrub, which is why the handle exists: the waveform itself is
      // already spoken for.
      if (selectClips && width > 0 && state.clips.length > 1) {
        const y = event.clientY - rect.top
        if (y <= DEFAULT_CLIP_STYLE.handleHeight) {
          const centre = deck.positionSeconds()
          const at = centre + (event.clientX - rect.left - width / 2) * (state.span / width)
          const grabbed = clipAt(state.clips, at)
          if (grabbed) {
            event.currentTarget.setPointerCapture(event.pointerId)
            // Mark the piece rather than the pointer: the row rearranges under
            // the hand, so the highlight has to travel with the piece.
            useDecks.getState().selectClip(deckId, grabbed.id)
            const perSec = width / state.span
            const left = rect.left + width / 2 + (grabbed.startSec - centre) * perSec
            clipDragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              clip: grabbed,
              width,
              height: rect.height,
              span: state.span,
              grabDx: event.clientX - left,
              dragging: false,
              cancelled: false
            }
            return
          }
        }
      }

      event.currentTarget.setPointerCapture(event.pointerId)
      // The deck is captured with the gesture: a track loaded mid-drag must not
      // leave the old one stuck in scrub mode.
      dragRef.current = {
        deck,
        startX: event.clientX,
        startTime: deck.positionSeconds(),
        canvasLeft: rect.left
      }
      deck.beginScrub()
    },
    [selectClips]
  )

  /**
   * Point the drag at whatever is under the hand, and say so.
   *
   * The same answer whether the hand is over the row the piece came from or
   * another one: the piece comes out of the order, and the row it is over says
   * where it would go back in. Nothing is written until the hand opens.
   */
  const aim = useCallback(
    (held: HeldClip, clientX: number, clientY: number): void => {
      const zone = zoneAt(clientX, clientY)
      const decks = useDecks.getState().decks
      const ghost = {
        clip: held.clip,
        x: clientX - held.grabDx,
        y: clientY - held.height / 2,
        width: Math.min((held.clip.durationSec / held.span) * held.width, held.width),
        height: held.height
      }
      if (!zone) {
        setClipDrag({ fromDeck: deckId, toDeck: null, index: 0, holeId: null, atSec: 0, ...ghost })
        return
      }
      const row =
        zone.deck === deckId
          ? rowWithout(decks[deckId].clips, held.clip.id)
          : decks[zone.deck].clips
      const at = aimInRow(row, held.clip, zone.timeAt(clientX))
      setClipDrag({ fromDeck: deckId, toDeck: zone.deck, ...at, ...ghost })
    },
    [deckId]
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      const held = clipDragRef.current
      if (held && held.pointerId === event.pointerId) {
        if (held.cancelled) return
        if (!held.dragging) {
          // Either direction: a piece taken to another row moves mostly down.
          if (
            Math.abs(event.clientX - held.startX) <= CLICK_SLOP_PX &&
            Math.abs(event.clientY - held.startY) <= CLICK_SLOP_PX
          ) {
            return
          }
          held.dragging = true
        }
        aim(held, event.clientX, event.clientY)
        dirtyRef.current = true
        return
      }
      onScrubMove(event)
    },
    [aim]
  )

  const onScrubMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): void => {
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
      const held = clipDragRef.current
      if (held && held.pointerId === event.pointerId) {
        clipDragRef.current = null
        dirtyRef.current = true
        const drag = clipDrag()
        setClipDrag(null)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        // A press that went nowhere is a click on the handle, which picks the
        // piece rather than moving it.
        if (!held.dragging) useDecks.getState().selectClip(deckId, held.clip.id)
        else if (!held.cancelled && drag && drag.toDeck) {
          useDecks.getState().dropClip(deckId, held.clip.id, drag.toDeck, {
            index: drag.index,
            holeId: drag.holeId,
            atSec: drag.atSec
          })
        }
        return
      }

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

  // Escape abandons a move. The gesture stays until the pointer comes up, so
  // the capture is still released there and the same press cannot pick it back
  // up halfway through.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const held = clipDragRef.current
      if (!held || !held.dragging || held.cancelled) return
      held.cancelled = true
      setClipDrag(null)
      dirtyRef.current = true
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deckId])

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
