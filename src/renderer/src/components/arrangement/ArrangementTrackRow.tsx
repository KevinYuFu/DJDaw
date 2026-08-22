import type { ReactElement } from 'react'
import { useArrangement } from '@renderer/state/useArrangement'

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

      <div className="arrange-track__lane" />

      <div className="arrange-track__controls" />
    </div>
  )
}
