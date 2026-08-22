import type { ReactElement } from 'react'
import { MAX_TRACKS } from '@shared/arrangement'
import { useArrangement } from '@renderer/state/useArrangement'
import { ArrangementRuler } from './ArrangementRuler'
import { ArrangementTrackRow } from './ArrangementTrackRow'
import './arrangement.css'

/**
 * Clips laid out on one timeline, the way a DAW arranges them.
 *
 * Its tracks are its own: nothing here is a deck, and switching to another
 * view carries nothing across. Every track shares one grid, and every clip
 * plays at whatever speed matches the arrangement's tempo, so a moment on one
 * lane is the same beat on the next.
 */
export function ArrangementView(): ReactElement {
  const trackIds = useArrangement((s) => s.trackIds)
  const addTrack = useArrangement((s) => s.addTrack)
  const playing = useArrangement((s) => s.playing)
  const play = useArrangement((s) => s.play)
  const pause = useArrangement((s) => s.pause)
  const zoomIndex = useArrangement((s) => s.zoomIndex)
  const setZoom = useArrangement((s) => s.setZoom)
  const bpm = useArrangement((s) => s.bpm)
  const setBpm = useArrangement((s) => s.setBpm)
  const snap = useArrangement((s) => s.snap)
  const toggleSnap = useArrangement((s) => s.toggleSnap)
  const full = trackIds.length >= MAX_TRACKS

  return (
    <div className="arrangement">
      <header className="arrangement__bar">
        <div className="arrangement__left">
          <button
            type="button"
            className="edit-btn"
            disabled={full}
            title={full ? `${MAX_TRACKS} tracks is the most` : 'Add a track'}
            onClick={() => addTrack()}
          >
            <span>Add Track</span>
          </button>

          <label className="arrangement__bpm" title="The tempo every clip is locked to">
            <span>BPM</span>
            <input
              type="number"
              min={20}
              max={300}
              step={0.01}
              value={bpm}
              onChange={(event) => setBpm(Number(event.target.value))}
            />
          </label>

          <button
            type="button"
            className={`edit-btn${snap ? ' is-lit' : ''}`}
            title="Snap to the grid — hold Alt to place by hand"
            onClick={toggleSnap}
          >
            <span>Snap</span>
          </button>
        </div>

        <button
          type="button"
          className={`edit-btn edit-btn--play${playing ? ' is-lit' : ''}`}
          onClick={() => (playing ? pause() : play())}
          title="Play / pause (Space)"
        >
          <svg className="edit-btn__icon" viewBox="0 0 12 12" aria-hidden="true">
            {playing ? <path d="M2 1h3v10H2zM7 1h3v10H7z" /> : <path d="M2.5 1L10.5 6L2.5 11z" />}
          </svg>
          <span>{playing ? 'Pause' : 'Play'}</span>
        </button>

        <div className="arrangement__right">
          <div className="arrangement__zoom">
            <button type="button" title="Zoom out (-)" onClick={() => setZoom(zoomIndex - 1)}>
              −
            </button>
            <button type="button" title="Zoom in (=)" onClick={() => setZoom(zoomIndex + 1)}>
              +
            </button>
          </div>
        </div>
      </header>

      <ArrangementRuler />

      <div className="arrangement__lanes">
        {trackIds.map((id) => (
          <ArrangementTrackRow key={id} trackId={id} />
        ))}
      </div>
    </div>
  )
}
