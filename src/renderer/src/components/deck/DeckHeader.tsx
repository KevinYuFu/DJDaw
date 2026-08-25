import { useEffect } from 'react'
import type { ReactElement } from 'react'
import type { BeatGrid, DeckId } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { barAtBeat, beatAtTime, beatInBar, bpmAt } from '@renderer/core/beatgrid'
import { formatBarBeat, formatBpm, formatTime } from '@renderer/core/format'
import { useRaf, useTextRef } from '@renderer/hooks/useRaf'
import { useDecks } from '@renderer/state/useDecks'
import { useLibrary } from '@renderer/state/useLibrary'

export interface DeckHeaderProps {
  deckId: DeckId
}

const EMPTY_TIME = '0:00.0'
const EMPTY_BAR = '-.-'

function barBeatAt(grid: BeatGrid, sec: number): string {
  const beat = beatAtTime(grid, sec)
  return formatBarBeat(barAtBeat(grid, beat), beatInBar(grid, beat))
}

/**
 * Artwork, title, key, and the readouts that move with the playhead.
 *
 * Elapsed, remaining, live BPM and the bar.beat counter are written straight
 * into their DOM nodes from a rAF loop, so the deck does not re-render sixty
 * times a second.
 */
export function DeckHeader({ deckId }: DeckHeaderProps): ReactElement {
  const status = useDecks((s) => s.decks[deckId].status)
  const trackId = useDecks((s) => s.decks[deckId].trackId)
  const track = useLibrary((s) => (trackId ? s.trackById(trackId) : undefined))

  const [bpmRef, setBpm] = useTextRef<HTMLDivElement>()
  const [barRef, setBar] = useTextRef<HTMLDivElement>()
  const [elapsedRef, setElapsed] = useTextRef<HTMLDivElement>()
  const [remainingRef, setRemaining] = useTextRef<HTMLDivElement>()

  // `deck()` throws until the engine has initialised, which `ready` implies.
  const deck = status === 'ready' ? AudioEngine.shared().deck(deckId) : null

  useRaf(() => {
    if (!deck) return
    // Read the stores here, so a grid nudge or a tempo move lands on the next
    // frame without restarting anything.
    const state = useDecks.getState().decks[deckId]
    const current = state.trackId ? useLibrary.getState().trackById(state.trackId) : undefined
    const grid = current?.grid ?? null
    const pos = deck.positionSeconds()
    const duration = deck.durationSec || current?.durationSec || 0

    setElapsed(formatTime(pos))
    setRemaining(formatTime(pos - duration))
    setBpm(formatBpm(grid ? bpmAt(grid, pos) * (1 + state.pitchPercent / 100) : null))
    setBar(grid ? barBeatAt(grid, pos) : EMPTY_BAR)
  }, deck !== null)

  // An emptied deck keeps whatever the last frame wrote unless it is cleared.
  useEffect(() => {
    if (deck) return
    setElapsed(EMPTY_TIME)
    setRemaining(`-${EMPTY_TIME}`)
    setBpm(formatBpm(null))
    setBar(EMPTY_BAR)
  }, [deck, setBpm, setBar, setElapsed, setRemaining])

  const title = track?.title ?? (status === 'loading' ? 'Loading' : 'No track loaded')
  const artist = track?.artist ?? ''

  return (
    <header className="deck-header">
      <div className="deck-badge">{deckId}</div>
      {track?.artwork ? (
        <img className="deck-art" src={track.artwork} alt="" draggable={false} />
      ) : (
        <div className="deck-art is-empty" />
      )}

      <div className="deck-titles">
        <div className="deck-title" title={title}>
          {title}
        </div>
        <div className="deck-artist" title={artist}>
          {artist}
        </div>
      </div>

      <div className="deck-stat">
        <div className="label">Key</div>
        <div className="deck-key mono">{track?.key ?? '--'}</div>
      </div>

      <div className="deck-stat deck-stat-bpm">
        <div className="label">BPM</div>
        <div className="deck-bpm mono" ref={bpmRef}>
          {formatBpm(null)}
        </div>
        <div className="deck-bar mono" ref={barRef}>
          {EMPTY_BAR}
        </div>
      </div>

      <div className="deck-stat deck-times">
        <div className="label">Time</div>
        <div className="deck-elapsed mono" ref={elapsedRef}>
          {EMPTY_TIME}
        </div>
        <div className="deck-remaining mono" ref={remainingRef}>
          {`-${EMPTY_TIME}`}
        </div>
      </div>
    </header>
  )
}
