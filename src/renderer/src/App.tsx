/*
 * Stylesheets first, and in this order: theme.css defines the variables every
 * other sheet reads, and modules are evaluated in import order, so pulling the
 * component sheets in here rather than letting each component's own import
 * decide keeps the cascade deterministic.
 */
import '@renderer/styles/theme.css'
import '@renderer/styles/app.css'
import '@renderer/components/deck/deck.css'
import '@renderer/components/waveform/waveform.css'
import '@renderer/components/browser/browser.css'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { DeckId } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { Browser } from '@renderer/components/browser/Browser'
import { analyzeTrackOffDeck } from '@renderer/components/browser/TrackTable'
import { Deck } from '@renderer/components/deck/Deck'
import { EditView } from '@renderer/components/edit/EditView'
import { Mixer } from '@renderer/components/Mixer'
import { Toolbar } from '@renderer/components/Toolbar'
import { clamp } from '@renderer/core/format'
import { useKeyboard } from '@renderer/hooks/useKeyboard'
import { useDecks } from '@renderer/state/useDecks'
import { useLibrary } from '@renderer/state/useLibrary'
import { useSettings } from '@renderer/state/useSettings'

/**
 * The window: toolbar, the current view, and the browser below a draggable
 * divider. This is also where the app's one-time wiring lives — engine
 * startup, library hydration, the key map and the application menu — because
 * everything below it is a view of the stores.
 *
 * Two views share the middle row: PERFORMANCE, the two decks either side of
 * the mixer, and EDIT, four tracks stacked. Only that row swaps. The toolbar
 * carries the tabs that switch it and the browser is where tracks come from,
 * so both stay on screen in either view.
 */

/** Must match the toolbar and handle rows in app.css. */
const TOOLBAR_H = 40
const HANDLE_H = 5
/** Below this a deck loses its transport row; below that the browser is a header. */
const MIN_DECK_H = 360
const MIN_BROWSER_H = 120
/** Deck height taken by everything but the detail waveform. */
const DECK_CHROME_H = 290
/** Detail waveform height a deck opens at. The splitter changes it from there. */
const DEFAULT_WAVE_H = 150

function clampDeckHeight(height: number): number {
  const max = window.innerHeight - TOOLBAR_H - HANDLE_H - MIN_BROWSER_H
  return clamp(height, MIN_DECK_H, Math.max(MIN_DECK_H, max))
}

/**
 * Re-run detection for the selected track.
 *
 * The work happens off the decks: a track being analysed in the browser is
 * usually not the one that is playing, and loading it somewhere to analyse it
 * would stop a deck mid-set. The result is written to the library, so a deck
 * that does hold the track picks the new grid up like any other grid edit.
 */
function reanalyzeSelection(): void {
  const { selectedId, trackById } = useLibrary.getState()
  const track = selectedId ? trackById(selectedId) : null
  if (!track) return
  void analyzeTrackOffDeck(track).catch((err: unknown) => {
    console.error('[app] analysis failed', track.path, err)
  })
}

function revealSelection(): void {
  const { selectedId, trackById } = useLibrary.getState()
  const track = selectedId ? trackById(selectedId) : null
  if (!track) return
  void window.api.revealInFinder(track.path).catch((err: unknown) => {
    console.error('[app] reveal failed', err)
  })
}

/** The command vocabulary is documented in `main/menu.ts`. */
function runMenuCommand(command: string): void {
  const deck = useSettings.getState().focusedDeck
  const decks = useDecks.getState()

  switch (command) {
    case 'import':
      void useLibrary
        .getState()
        .importFiles()
        .catch((err: unknown) => console.error('[app] import failed', err))
      break
    case 'import-rekordbox':
      void useLibrary
        .getState()
        .importRekordbox()
        .catch((err: unknown) => console.error('[app] rekordbox import failed', err))
      break
    case 'analyze':
      reanalyzeSelection()
      break
    case 'reveal':
      revealSelection()
      break
    case 'zoom-in':
      // Zoom levels are seconds across the waveform, so zooming in steps down.
      decks.setZoom(deck, decks.decks[deck].zoomIndex - 1)
      break
    case 'zoom-out':
      decks.setZoom(deck, decks.decks[deck].zoomIndex + 1)
      break
    case 'play':
      decks.togglePlay(deck)
      break
    case 'cue':
      // A menu click is a press and an immediate release. Without the release,
      // a preview started from the cue point would have nothing to end it.
      decks.cuePress(deck)
      decks.cueRelease(deck)
      break
    case 'beat-jump-back':
      decks.beatJump(deck, -decks.decks[deck].beatJumpBeats)
      break
    case 'beat-jump-forward':
      decks.beatJump(deck, decks.decks[deck].beatJumpBeats)
      break
    default:
      console.warn('[app] unknown menu command', command)
  }
}

function AnalysingOverlay({ id }: { id: DeckId }): ReactElement {
  const trackId = useDecks((s) => s.decks[id].trackId)
  const title = useLibrary((s) => (trackId ? s.trackById(trackId)?.title : undefined))
  return (
    <div className="analysing" role="status" aria-live="polite">
      <span className="analysing__title">{title ?? 'Loading track'}</span>
      <span className="analysing__label label">Analysing</span>
      {/* Decode, waveform and tempo detection report no progress, so the bar is
          deliberately indeterminate rather than a fabricated percentage. */}
      <div className="analysing__bar" />
    </div>
  )
}

function DeckSlot({ id }: { id: DeckId }): ReactElement {
  const status = useDecks((s) => s.decks[id].status)
  return (
    <div className="deck-slot" data-deck={id}>
      <Deck deckId={id} />
      {status === 'loading' && <AnalysingOverlay id={id} />}
    </div>
  )
}

export function App(): ReactElement {
  const view = useSettings((s) => s.view)
  const browserExpanded = useSettings((s) => s.browserExpanded)
  const toggleBrowserExpanded = useSettings((s) => s.toggleBrowserExpanded)
  const [deckHeight, setDeckHeight] = useState(() => clampDeckHeight(DECK_CHROME_H + DEFAULT_WAVE_H))
  const [resizing, setResizing] = useState(false)
  const drag = useRef<{ pointerY: number; height: number } | null>(null)

  useKeyboard()

  useEffect(() => {
    void AudioEngine.shared()
      .init()
      .catch((err: unknown) => console.error('[app] audio engine failed to start', err))
    void useLibrary
      .getState()
      .loadFromDisk()
      .catch((err: unknown) => console.error('[app] library load failed', err))
  }, [])

  // An AudioContext starts suspended until a gesture, and the gesture that
  // unlocks it may well be a click on the waveform rather than on a button.
  useEffect(() => {
    const unlock = (): void => {
      void AudioEngine.shared()
        .resume()
        .catch((err: unknown) => console.warn('[app] audio resume failed', err))
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  useEffect(() => window.api.onMenuCommand(runMenuCommand), [])

  useEffect(() => {
    const onResize = (): void => setDeckHeight((height) => clampDeckHeight(height))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onHandleDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      drag.current = { pointerY: event.clientY, height: deckHeight }
      // Captured so the divider keeps following a pointer dragged over a deck.
      event.currentTarget.setPointerCapture(event.pointerId)
      setResizing(true)
    },
    [deckHeight]
  )

  const onHandleMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (!start) return
    setDeckHeight(clampDeckHeight(start.height + (event.clientY - start.pointerY)))
  }, [])

  const onHandleUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null
    setResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const isMac = navigator.userAgent.includes('Mac OS X')
  const classes = ['app']
  if (isMac) classes.push('app--mac')
  if (!browserExpanded) classes.push('is-browser-collapsed')
  if (resizing) classes.push('is-resizing')

  // A custom property is the tidiest way to feed a dragged pixel value into a
  // grid template; CSSProperties has no index signature, hence the cast.
  const layout = { '--deck-height': `${deckHeight}px` } as CSSProperties

  return (
    <div className={classes.join(' ')} style={layout}>
      <Toolbar />

      {view === 'edit' ? (
        <main className="edit-area">
          <EditView />
        </main>
      ) : (
        <main className="deck-area">
          <DeckSlot id="A" />
          <Mixer />
          <DeckSlot id="B" />
        </main>
      )}

      <div
        className="split-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the browser"
        title="Drag to resize · double-click to collapse the browser"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        onDoubleClick={toggleBrowserExpanded}
      />

      <section className="browser-area">
        <Browser />
      </section>
    </div>
  )
}
