import { useRef, type DragEvent, type PointerEvent, type ReactElement } from 'react'
import type { ClipTrack } from '@waveform-playlist/core'
import { flatChannel } from '@shared/eq'
import { faderGain, faderPositionForDb } from '@shared/fader'
import { draggedTrackId, TRACK_DRAG_MIME } from '@renderer/core/dragTypes'
import { ChannelFader, ChannelKnobs } from '@renderer/components/mixer/ChannelKnobs'
import { useSettings } from '@renderer/state/useSettings'
import { useArrangement, type ClipSelection } from '@renderer/state/useArrangement'
import type { ArrangementClip } from '@renderer/arrangement/WorkletPlayout'
import { ArrangementClips } from '@renderer/components/arrangement/ArrangementClips'
import { placeClip } from '@renderer/arrangement/placement'
import { useLibrary } from '@renderer/state/useLibrary'

/** How far a pointer moves before a click on a clip becomes a drag. */
const DRAG_SLOP_PX = 3

export interface ArrangementLaneProps {
  lane: ClipTrack
  fromSec: number
  secPerPx: number
  width: number
  height: number
  /** Arrangement seconds in one bar, for snapping. */
  barSec: number
  selected: ClipSelection | null
  onSelect(selection: ClipSelection | null): void
  onScrub(seconds: number): void
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
  fromSec,
  secPerPx,
  width,
  height,
  barSec,
  selected,
  onSelect,
  onScrub
}: ArrangementLaneProps): ReactElement {
  const eqMode = useSettings((s) => s.eqMode)
  const channel = useArrangement((s) => s.channels[lane.id])
  const sampleRate = useArrangement((s) => s.sampleRate)
  const ghost = useArrangement((s) => (s.preview?.lane === lane.id ? s.preview : null))
  const drag = useRef<{
    pointerId: number
    clipId: string
    startX: number
    startSec: number
    moved: boolean
  } | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)

  const snap = (sec: number): number => Math.max(0, Math.round(sec / barSec) * barSec)
  const secAt = (clientX: number): number => {
    const box = stripRef.current?.getBoundingClientRect()
    if (!box) return fromSec
    return fromSec + (clientX - box.left) * secPerPx
  }

  const onDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const at = secAt(e.clientX)
    const clip = clipAt(lane, at, sampleRate)
    if (!clip) {
      onSelect(null)
      onScrub(snap(at))
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    onSelect({ lane: lane.id, clipId: clip.id })
    drag.current = {
      pointerId: e.pointerId,
      clipId: clip.id,
      startX: e.clientX,
      startSec: clip.startSample / sampleRate,
      moved: false
    }
  }

  const onMove = (e: PointerEvent<HTMLDivElement>): void => {
    const held = drag.current
    if (!held || held.pointerId !== e.pointerId) return
    const travel = e.clientX - held.startX
    if (!held.moved && Math.abs(travel) < DRAG_SLOP_PX) return
    if (!held.moved) useArrangement.getState().beginDrag()
    held.moved = true
    // Snapped where it lands, so a clip that started on a bar line stays on one.
    const wanted = snap(held.startSec + travel * secPerPx)
    const current = useArrangement.getState().lanes.find((l) => l.id === lane.id)
    const clip = current?.clips.find((c) => c.id === held.clipId)
    if (!clip) return
    const delta = wanted - clip.startSample / sampleRate
    if (Math.abs(delta) > 1e-6) useArrangement.getState().moveClip(lane.id, held.clipId, delta)
  }

  const onUp = (): void => {
    if (drag.current?.moved) useArrangement.getState().endDrag()
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
    arrangement.setPreview({ lane: lane.id, sourceId: trackId, ...placed })
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
        <span className="arr-lane__badge">{lane.name}</span>
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
        <span className="arr-lane__count mono">
          {lane.clips.length === 0 ? '—' : `${lane.clips.length} clip${lane.clips.length > 1 ? 's' : ''}`}
        </span>
      </div>

      <div
        ref={stripRef}
        className="arr-lane__strip"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
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
          ghost={ghost}
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
