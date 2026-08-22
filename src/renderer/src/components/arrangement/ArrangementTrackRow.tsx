import type { ReactElement } from 'react'
import { CENTRE, flatChannel } from '@shared/eq'
import { FADER_UNITY } from '@shared/fader'
import { ChannelEqStrip, ChannelFader } from '@renderer/components/channel/ChannelControls'
import { useArrangement } from '@renderer/state/useArrangement'
import { ArrangementLane } from './ArrangementLane'

/**
 * One lane, with its name and controls on either side of the timeline.
 *
 * Clicking anywhere on it picks the track, which is what the up, down and
 * delete keys act on.
 */
export function ArrangementTrackRow({ trackId }: { trackId: string }): ReactElement {
  const track = useArrangement((s) => s.tracks[trackId])
  const selected = useArrangement((s) => s.selectedTrackId === trackId)
  const selectTrack = useArrangement((s) => s.selectTrack)
  const trackIds = useArrangement((s) => s.trackIds)
  const moveSelectedTrack = useArrangement((s) => s.moveSelectedTrack)
  const at = trackIds.indexOf(trackId)

  const nudge = (by: number) => (): void => {
    selectTrack(trackId)
    moveSelectedTrack(by)
  }

  return (
    <div
      className={`arrange-track${selected ? ' is-selected' : ''}`}
      data-track={trackId}
      onPointerDown={() => selectTrack(trackId)}
    >
      <div className="arrange-track__head">
        <span className="arrange-track__name">{track?.name ?? ''}</span>
        <div className="arrange-track__order">
          <button type="button" disabled={at <= 0} onClick={nudge(-1)} title="Move up">
            ▲
          </button>
          <button
            type="button"
            disabled={at < 0 || at >= trackIds.length - 1}
            onClick={nudge(1)}
            title="Move down"
          >
            ▼
          </button>
        </div>
      </div>

      <ArrangementLane trackId={trackId} />

      <div className="arrange-track__controls">
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
