import type { ReactElement } from 'react'
import type { DeckId } from '@shared/types'
import { DeckHeader } from '@renderer/components/deck/DeckHeader'
import { JogWheel } from '@renderer/components/deck/JogWheel'
import { PadSection } from '@renderer/components/deck/PadSection'
import { TempoFader } from '@renderer/components/deck/TempoFader'
import { Transport } from '@renderer/components/deck/Transport'
import { DetailWaveform } from '@renderer/components/waveform/DetailWaveform'
import { OverviewWaveform } from '@renderer/components/waveform/OverviewWaveform'
import { useSettings } from '@renderer/state/useSettings'
import './deck.css'

export interface DeckProps {
  deckId: DeckId
}

/**
 * One deck, laid out like the front of a CDJ: track header, both waveforms,
 * then the hardware row of platter, transport, tempo fader and pads.
 *
 * Nothing here holds playback state. Every child reads the store for what
 * changes slowly and the engine for what changes every frame.
 */
export function Deck({ deckId }: DeckProps): ReactElement {
  const focused = useSettings((s) => s.focusedDeck === deckId)

  return (
    <section
      className={`deck${focused ? ' is-focused' : ''}`}
      data-deck={deckId}
      // Touching a deck aims the unshifted keyboard shortcuts at it, the way
      // reaching for the hardware does.
      onPointerDown={() => useSettings.getState().setFocusedDeck(deckId)}
    >
      <DeckHeader deckId={deckId} />

      <div className="deck-waves">
        <OverviewWaveform deckId={deckId} />
        <DetailWaveform deckId={deckId} />
      </div>

      <div className="deck-controls">
        <JogWheel deckId={deckId} />
        <div className="deck-mid">
          <Transport deckId={deckId} />
          <TempoFader deckId={deckId} />
        </div>
        <PadSection deckId={deckId} />
      </div>
    </section>
  )
}
