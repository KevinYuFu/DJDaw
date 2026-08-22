import { useState } from 'react'
import type { ReactElement } from 'react'
import { CENTRE, flatChannel } from '@shared/eq'
import { FADER_UNITY } from '@shared/fader'
import { ChannelEqStrip, ChannelFader } from '@renderer/components/channel/ChannelControls'
import { useArrangement } from '@renderer/state/useArrangement'
import { ArrangementLane } from './ArrangementLane'

/** What a track header being dragged up or down the stack carries. */
const TRACK_ROW_DRAG_TYPE = 'application/x-djdaw-arrange-track'

/**
 * One lane, with its name on the left and its channel on the right.
 *
 * Clicking anywhere on it picks the track, which is what Delete acts on.
 * Dragging its name moves it up or down the stack.
 */
export function ArrangementTrackRow({ trackId }: { trackId: string }): ReactElement {
  const track = useArrangement((s) => s.tracks[trackId])
  const selected = useArrangement((s) => s.selectedTrackId === trackId)
  const selectTrack = useArrangement((s) => s.selectTrack)
  const [over, setOver] = useState<'above' | 'below' | null>(null)

  return (
    <div
      className={`arrange-track${selected ? ' is-selected' : ''}`}
      data-track={trackId}
      onPointerDown={() => selectTrack(trackId)}
    >
      <div
        className={`arrange-track__head${over ? ` is-over-${over}` : ''}`}
        draggable
        title="Drag to move this track up or down"
        onDragStart={(event) => {
          event.dataTransfer.setData(TRACK_ROW_DRAG_TYPE, trackId)
          event.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(TRACK_ROW_DRAG_TYPE)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          const box = event.currentTarget.getBoundingClientRect()
          setOver(event.clientY < box.top + box.height / 2 ? 'above' : 'below')
        }}
        onDragLeave={() => setOver(null)}
        onDrop={(event) => {
          const moving = event.dataTransfer.getData(TRACK_ROW_DRAG_TYPE)
          setOver(null)
          if (!moving || moving === trackId) return
          event.preventDefault()
          const box = event.currentTarget.getBoundingClientRect()
          const after = event.clientY >= box.top + box.height / 2
          const ids = useArrangement.getState().trackIds
          const target = ids.indexOf(trackId)
          const from = ids.indexOf(moving)
          // Taking it out first shifts everything after it up by one.
          useArrangement
            .getState()
            .moveTrackTo(moving, target + (after ? 1 : 0) - (from < target ? 1 : 0))
        }}
      >
        <span className="arrange-track__name">{track?.name ?? ''}</span>
      </div>

      <ArrangementLane trackId={trackId} />

      <div className="arrange-track__channel">
        <ChannelFader
          label={track?.name ?? 'Track'}
          position={track?.fader ?? FADER_UNITY}
          disabled={!track}
          onChange={(position) => useArrangement.getState().setTrackFader(trackId, position)}
        />
        <ChannelEqStrip
          label={track?.name ?? 'Track'}
          eq={track?.eq ?? flatChannel()}
          disabled={!track}
          onKnob={(id, value) =>
            track && useArrangement.getState().setTrackEq(trackId, { ...track.eq, [id]: value })
          }
          onResetKnob={(id) =>
            track && useArrangement.getState().setTrackEq(trackId, { ...track.eq, [id]: CENTRE })
          }
          onResetAll={() => useArrangement.getState().setTrackEq(trackId, flatChannel())}
        />
      </div>
    </div>
  )
}
