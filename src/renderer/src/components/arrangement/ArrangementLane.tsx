import { useRef, useState, type DragEvent, type PointerEvent, type ReactElement } from 'react'
import type { ClipTrack } from '@waveform-playlist/core'
import { flatChannel } from '@shared/eq'
import { faderGain, faderPositionForDb } from '@shared/fader'
import { TRACK_DRAG_MIME } from '@renderer/core/dragTypes'
import { ChannelFader, ChannelKnobs } from '@renderer/components/mixer/ChannelKnobs'
import { useSettings } from '@renderer/state/useSettings'
import { useArrangement } from '@renderer/state/useArrangement'
import type { ArrangementClip } from '@renderer/arrangement/WorkletPlayout'
import { ArrangementClips } from '@renderer/components/arrangement/ArrangementClips'

/** How far a pointer moves before a click on a clip becomes a drag. */
const DRAG_SLOP_PX = 3

export interface Selection {
  lane: string
  clipId: string
}

export interface ArrangementLaneProps {
  lane: ClipTrack
  fromSec: number
  secPerPx: number
  width: number
  height: number
  /** Arrangement seconds in one bar, for snapping. */
  barSec: number
  selected: Selection | null
  onSelect(selection: Selection | null): void
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
 * The lane is a place, not a track — it holds clips from as many songs as get
 * dropped on it, and its channel applies to all of them.
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
  const [over, setOver] = useState(false)
  const drag = useRef<{
    pointerId: number
    clipId: string
    startX: number
    startSec: number
    moved: boolean
  } | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)

  const sampleRate = 48000
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
    held.moved = true
    // Snapped where it lands rather than by how far it came, so a clip that
    // started on a bar line stays on one.
    const wanted = snap(held.startSec + travel * secPerPx)
    const current = useArrangement.getState().lanes.find((l) => l.id === lane.id)
    const clip = current?.clips.find((c) => c.id === held.clipId)
    if (!clip) return
    const delta = wanted - clip.startSample / sampleRate
    if (Math.abs(delta) > 1e-6) useArrangement.getState().moveClip(lane.id, held.clipId, delta)
  }

  const onUp = (): void => {
    drag.current = null
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes(TRACK_DRAG_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setOver(true)
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    const trackId = e.dataTransfer.getData(TRACK_DRAG_MIME)
    setOver(false)
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
        className={`arr-lane__strip${over ? ' is-over' : ''}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDragOver={onDragOver}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <ArrangementClips
          lane={lane}
          fromSec={fromSec}
          secPerPx={secPerPx}
          width={width}
          height={height}
          selectedClipId={laneSelected}
        />
        {lane.clips.length === 0 ? (
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
