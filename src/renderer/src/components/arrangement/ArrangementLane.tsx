import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
  type ReactElement
} from 'react'
import type { ClipTrack } from '@waveform-playlist/core'
import { flatChannel } from '@shared/eq'
import { faderGain, faderPositionForDb } from '@shared/fader'
import { draggedTrackId, TRACK_DRAG_MIME } from '@renderer/core/dragTypes'
import { ChannelFader, ChannelKnobs } from '@renderer/components/mixer/ChannelKnobs'
import { useSettings } from '@renderer/state/useSettings'
import {
  useArrangement,
  type ClipEdge,
  type ClipSelection
} from '@renderer/state/useArrangement'
import { laneTitle } from '@renderer/arrangement/laneTitle'
import type { ArrangementClip } from '@renderer/arrangement/WorkletPlayout'
import {
  ArrangementClips,
  CLIP_HEADER_H
} from '@renderer/components/arrangement/ArrangementClips'
import { placeClip } from '@renderer/arrangement/placement'
import { useLibrary } from '@renderer/state/useLibrary'

/** High to low, then the colour knob, which is not one of the bands. */
const LANE_KNOBS = ['high', 'mid', 'low', 'filter'] as const

/** How far a pointer moves before a click on a clip becomes a drag. */
const DRAG_SLOP_PX = 3

/** How near a clip's end a press counts as taking hold of that end. */
const TRIM_GRIP_PX = 7

export interface ArrangementLaneProps {
  lane: ClipTrack
  /** Where the lane sits in the list, for a lane that has no name yet. */
  index: number
  fromSec: number
  secPerPx: number
  width: number
  height: number
  /** Arrangement seconds in one bar, for snapping and for the grid. */
  barSec: number
  /** Beats in a bar. */
  beatsPerBar: number
  selected: ClipSelection | null
  onSelect(selection: ClipSelection | null): void
  /** The lane under a screen position, so a clip can be dragged onto another. */
  laneAt(clientY: number): string | null
}

/** The clip under an arrangement position, if any. */
function clipAt(lane: ClipTrack, sec: number, sampleRate: number): ArrangementClip | null {
  for (const raw of lane.clips) {
    const clip = raw as ArrangementClip
    const start = clip.startSample / sampleRate
    const end = (clip.startSample + clip.durationSamples) / sampleRate
    if (sec >= start && sec < end) return clip
  }
  return null
}

/**
 * One track of the arrangement: a channel on the left, a stretch of time on
 * the right.
 *
 * A lane holds clips from any number of songs. Its channel applies to all
 * of them.
 */
export function ArrangementLane({
  lane,
  index,
  fromSec,
  secPerPx,
  width,
  height,
  barSec,
  beatsPerBar,
  selected,
  onSelect,
  laneAt
}: ArrangementLaneProps): ReactElement {
  const eqMode = useSettings((s) => s.eqMode)
  const title = useArrangement((s) => laneTitle(s.titles, lane.id, index, lane.clips.length > 0))
  const channel = useArrangement((s) => s.channels[lane.id])
  const sampleRate = useArrangement((s) => s.sampleRate)
  const ghost = useArrangement((s) => (s.preview?.lane === lane.id ? s.preview : null))
  const drag = useRef<{
    pointerId: number
    kind: 'move' | 'left' | 'right'
    clipId: string
    startX: number
    startSec: number
    moved: boolean
    /** Where the shadow was last put, so holding Cmd can redraw it in place. */
    atLane?: string
    atSample?: number
  } | null>(null)
  /** The clip end the pointer is over, which shows a grip and resizes. */
  const [grip, setGrip] = useState<{ clipId: string; edge: ClipEdge } | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  /** The pointer holding the playhead, or null. */
  const scrub = useRef<number | null>(null)

  // Everything that lands on the timeline lands on the grid: the playhead, a
  // clip being dragged, and a track dropped in from the browser.
  const step = barSec / Math.max(1, beatsPerBar)
  const snap = (sec: number): number => Math.max(0, Math.round(sec / step) * step)
  const secAt = (clientX: number): number => {
    const box = stripRef.current?.getBoundingClientRect()
    if (!box) return fromSec
    return fromSec + (clientX - box.left) * secPerPx
  }

  /** The x a time sits at, in pixels from the left of the strip. */
  const pxAt = (sec: number): number => (sec - fromSec) / secPerPx

  /**
   * The end of `clip` the pointer is near enough to take hold of, if any.
   *
   * The grip never takes more than a third of the clip from either side, so
   * the middle of even a very short clip is always somewhere to pick it up by.
   */
  const edgeOf = (clip: ArrangementClip, atSec: number): ClipEdge | null => {
    const left = pxAt(clip.startSample / sampleRate)
    const right = pxAt((clip.startSample + clip.durationSamples) / sampleRate)
    const reach = Math.min(TRIM_GRIP_PX, (right - left) / 3)
    const x = pxAt(atSec)
    if (x - left <= reach) return 'left'
    if (right - x <= reach) return 'right'
    return null
  }

  /**
   * A press picks the clip under it, wherever on that clip it lands.
   *
   * On the title strip it also takes hold: near either end of the clip that
   * end follows the pointer, showing more or less of the clip's source;
   * anywhere else along the strip the whole clip does, and it can be carried
   * onto any lane. Away from the title strip the press takes the playhead
   * instead, so one press on a waveform both picks the clip and says where in
   * it to cut. A press on empty grid picks nothing and only moves the playhead.
   */
  const onDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const box = stripRef.current?.getBoundingClientRect()
    const at = secAt(e.clientX)
    const clip = clipAt(lane, at, sampleRate)
    const onHeader = box ? e.clientY - box.top < CLIP_HEADER_H : false

    e.currentTarget.setPointerCapture(e.pointerId)
    onSelect(clip ? { lane: lane.id, clipId: clip.id } : null)

    if (clip && onHeader) {
      drag.current = {
        pointerId: e.pointerId,
        kind: edgeOf(clip, at) ?? 'move',
        clipId: clip.id,
        startX: e.clientX,
        startSec: clip.startSample / sampleRate,
        moved: false
      }
      return
    }
    scrub.current = e.pointerId
    useArrangement.getState().setScrub(snap(at))
  }

  const onMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (scrub.current === e.pointerId) {
      useArrangement.getState().setScrub(snap(secAt(e.clientX)))
      return
    }
    const grabbed = drag.current
    if (!grabbed || grabbed.pointerId !== e.pointerId) {
      // Not dragging: show which end the pointer would take hold of.
      const box = stripRef.current?.getBoundingClientRect()
      const over = box && e.clientY - box.top < CLIP_HEADER_H
      const clip = over ? clipAt(lane, secAt(e.clientX), sampleRate) : null
      const edge = clip ? edgeOf(clip, secAt(e.clientX)) : null
      setGrip(clip && edge ? { clipId: clip.id, edge } : null)
      return
    }
    // A release that never arrived would otherwise leave the lane holding the
    // clip for good, with nothing able to put it down.
    if (e.buttons === 0) {
      onUp(e)
      return
    }
    const travel = e.clientX - grabbed.startX
    if (!grabbed.moved && Math.abs(travel) < DRAG_SLOP_PX) return
    const arrangement = useArrangement.getState()
    if (!grabbed.moved) {
      grabbed.moved = true
      if (grabbed.kind === 'move') arrangement.beginClipMove(lane.id, grabbed.clipId)
      else arrangement.beginClipTrim(lane.id, grabbed.clipId, grabbed.kind)
    }
    if (grabbed.kind === 'move') {
      // Moved by whole grid steps rather than snapped to them. A clip is placed
      // so its downbeat sits on the grid, which its own start need not; stepping
      // keeps that alignment, where snapping the start would break it.
      const wanted = grabbed.startSec + Math.round((travel * secPerPx) / step) * step
      grabbed.atLane = laneAt(e.clientY) ?? lane.id
      grabbed.atSample = Math.max(0, wanted) * sampleRate
      arrangement.previewClipMove(grabbed.atLane, grabbed.atSample, e.metaKey || e.ctrlKey)
      return
    }
    arrangement.previewClipTrim(snap(secAt(e.clientX)) * sampleRate)
  }

  const onUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (scrub.current === e.pointerId) {
      // The playhead is only handed to the transport on release, so a drag
      // across a running arrangement does not restart it on every frame.
      const arrangement = useArrangement.getState()
      const at = arrangement.scrub
      arrangement.setScrub(null)
      if (at !== null) arrangement.seek(at)
      scrub.current = null
      return
    }
    if (drag.current?.moved) useArrangement.getState().commitClipDrag()
    drag.current = null
  }

  // Cmd can be taken up or let go without the pointer moving, and the shadow
  // has to say which it is at that moment.
  useEffect(() => {
    const onModifier = (e: KeyboardEvent): void => {
      if (e.key !== 'Meta' && e.key !== 'Control') return
      const grabbed = drag.current
      if (!grabbed || grabbed.kind !== 'move' || grabbed.atLane === undefined) return
      if (grabbed.atSample === undefined) return
      useArrangement
        .getState()
        .previewClipMove(grabbed.atLane, grabbed.atSample, e.type === 'keydown')
    }
    window.addEventListener('keydown', onModifier)
    window.addEventListener('keyup', onModifier)
    return () => {
      window.removeEventListener('keydown', onModifier)
      window.removeEventListener('keyup', onModifier)
    }
  }, [])

  const onCancel = (e: PointerEvent<HTMLDivElement>): void => {
    if (scrub.current === e.pointerId) {
      useArrangement.getState().setScrub(null)
      scrub.current = null
      return
    }
    if (drag.current?.moved) useArrangement.getState().cancelClipDrag()
    drag.current = null
  }

  /**
   * Draw the clip where it will land, at the size it will be, from the same
   * placement the drop uses.
   */
  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes(TRACK_DRAG_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const trackId = draggedTrackId()
    const track = trackId ? useLibrary.getState().trackById(trackId) : undefined
    if (!trackId || !track) return

    const arrangement = useArrangement.getState()
    if (arrangement.preview?.sourceId !== trackId) void arrangement.ensurePeaks(trackId)
    const own = track.grid?.anchors?.[0]?.bpm ?? track.bpm ?? 0
    // Dropping into an empty arrangement sets the grid to this track, so the
    // preview has to show it unwarped, exactly as the drop will place it.
    const empty = arrangement.lanes.every((l) => l.clips.length === 0)
    const masterBpm = empty && own > 0 ? own : arrangement.masterBpm
    const placed = placeClip({
      sourceFrames: arrangement.sourceFrames(trackId),
      downbeatSec: track.grid?.anchors?.[0]?.time ?? 0,
      trackBpm: own,
      masterBpm,
      atSeconds: snap(secAt(e.clientX)),
      sampleRate
    })
    // Snapping puts most of these on the same bar as the last one.
    const shown = arrangement.preview
    if (
      shown &&
      shown.lane === lane.id &&
      shown.sourceId === trackId &&
      shown.startSample === placed.startSample &&
      shown.durationSamples === placed.durationSamples
    ) {
      return
    }
    arrangement.setPreview({ lane: lane.id, sourceId: trackId, copy: false, ...placed })
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    const trackId = e.dataTransfer.getData(TRACK_DRAG_MIME)
    useArrangement.getState().setPreview(null)
    if (!trackId) return
    e.preventDefault()
    void useArrangement.getState().dropTrack(lane.id, trackId, snap(secAt(e.clientX)))
  }

  const knobs = channel ?? { eq: flatChannel(), mode: eqMode }
  const laneSelected = selected?.lane === lane.id ? selected.clipId : null

  return (
    <section className={`arr-lane${lane.soloed ? ' is-soloed' : ''}`} data-lane={lane.name}>
      <div className="arr-lane__edge" />

      <div className="arr-lane__info">
        <span className="arr-lane__title" title={title}>
          {title}
        </span>
        <div className="arr-lane__buttons">
          <button
            type="button"
            className={`arr-btn arr-btn--mute${lane.muted ? ' is-lit' : ''}`}
            title="Mute this lane"
            onClick={() => useArrangement.getState().toggleMute(lane.id)}
          >
            M
          </button>
          <button
            type="button"
            className={`arr-btn arr-btn--solo${lane.soloed ? ' is-lit' : ''}`}
            title="Solo this lane"
            onClick={() => useArrangement.getState().toggleSolo(lane.id)}
          >
            S
          </button>
        </div>
      </div>

      <div
        ref={stripRef}
        className="arr-lane__strip"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
        onPointerLeave={() => setGrip(null)}
        style={grip ? { cursor: 'ew-resize' } : undefined}
        onDragOver={onDragOver}
        onDragLeave={() => useArrangement.getState().setPreview(null)}
        onDrop={onDrop}
      >
        <ArrangementClips
          lane={lane}
          fromSec={fromSec}
          secPerPx={secPerPx}
          width={width}
          height={height}
          selectedClipId={laneSelected}
          grip={grip}
          ghost={ghost}
          barSec={barSec}
          beatsPerBar={beatsPerBar}
        />
        {lane.clips.length === 0 && !ghost ? (
          <span className="arr-lane__empty">Drag a track here</span>
        ) : null}
      </div>

      <ChannelFader
        position={faderPosition(lane.volume)}
        disabled={false}
        label={`Lane ${lane.name} fader`}
        prefix="arr"
        onChange={(next) => useArrangement.getState().setLaneVolume(lane.id, faderGain(next))}
      />

      <ChannelKnobs
        label={`Lane ${lane.name}`}
        eq={knobs.eq}
        mode={eqMode}
        disabled={false}
        prefix="arr"
        showFlat={false}
        knobOrder={LANE_KNOBS}
        onChange={(id, value) =>
          useArrangement.getState().setLaneEq(lane.id, { ...knobs.eq, [id]: value })
        }
        onReset={(id) =>
          useArrangement.getState().setLaneEq(lane.id, { ...knobs.eq, [id]: 0.5 })
        }
        onFlat={() => useArrangement.getState().setLaneEq(lane.id, flatChannel())}
      />
    </section>
  )
}

/** The fader position that produces a given gain, for drawing the handle. */
function faderPosition(gain: number): number {
  return faderPositionForDb(gain > 0 ? 20 * Math.log10(gain) : -Infinity)
}
