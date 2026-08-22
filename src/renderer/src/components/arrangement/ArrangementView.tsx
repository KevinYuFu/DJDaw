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
 * view carries nothing across. Every track shares one grid, so zooming moves
 * all of them together and a moment on one lane is the same moment on the next.
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

  return (
    <div className="arrangement">
      <header className="arrangement__bar">
        <button
          type="button"
          className="arrangement__add"
          disabled={trackIds.length >= MAX_TRACKS}
          title={
            trackIds.length >= MAX_TRACKS ? `${MAX_TRACKS} tracks is the most` : 'Add a track'
          }
          onClick={() => addTrack()}
        >
          + TRACK
        </button>

        <button
          type="button"
          className={`arrangement__play${playing ? ' is-lit' : ''}`}
          title="Play every track from the playhead (Space)"
          onClick={() => (playing ? pause() : play())}
        >
          {playing ? 'STOP' : 'PLAY'}
        </button>

        <label className="arrangement__bpm" title="The tempo the grid is built from">
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
          className={`arrangement__snap${snap ? ' is-lit' : ''}`}
          title="Snap what lands on the timeline to the grid — hold Alt to place by hand"
          onClick={toggleSnap}
        >
          SNAP
        </button>

        <div className="arrangement__zoom">
          <button type="button" title="Zoom out (-)" onClick={() => setZoom(zoomIndex - 1)}>
            −
          </button>
          <button type="button" title="Zoom in (=)" onClick={() => setZoom(zoomIndex + 1)}>
            +
          </button>
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
