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
import { Busy } from '@renderer/components/Busy'
import { EditView } from '@renderer/components/edit/EditView'
import { EditV2View } from '@renderer/components/editv2/EditV2View'
import { ArrangementView } from '@renderer/components/arrangement/ArrangementView'
import { Mixer } from '@renderer/components/Mixer'
import { Toolbar } from '@renderer/components/Toolbar'
import { clamp } from '@renderer/core/format'
import { useKeyboard } from '@renderer/hooks/useKeyboard'
import { useDecks } from '@renderer/state/useDecks'
import { useLibrary } from '@renderer/state/useLibrary'
import { useSettings } from '@renderer/state/useSettings'
import type { ViewName } from '@renderer/state/useSettings'

/**
 * The window: toolbar, the current view, and the browser below a draggable
 * divider. The app's one-time wiring lives here — engine startup, library
 * hydration, the key map and the application menu.
 *
 * The views share the middle row and only that row swaps: PERFORMANCE puts two
 * decks either side of the mixer, the editing views stack four tracks, and the
 * arrangement lays out lanes. The toolbar and the browser stay on screen
 * throughout.
 */

/** Must match the toolbar and handle rows in app.css. */
const TOOLBAR_H = 40
const HANDLE_H = 5
const MIN_BROWSER_H = 120
/** Deck height taken by everything but the detail waveform. */
const DECK_CHROME_H = 290
/** Detail waveform height a deck opens at. The splitter changes it from there. */
const DEFAULT_WAVE_H = 150

/** The editing view's export bar and the gaps between its four rows. */
const EDIT_CHROME_H = 38
/** One editing row: transport, EQ strip, pads, and the row's own padding. */
const EDIT_ROW_MIN_H = 110
const EDIT_ROW_H = 126

/** Transport bar plus the bar ruler. */
const ARRANGEMENT_CHROME_H = 58
const ARRANGEMENT_LANE_H = 85

/**
 * The two views want different amounts of height and get their own, so the
 * performance view can run a short waveform over a tall browser while the
 * editing view still has room for four full rows.
 */
const VIEW_HEIGHTS: Record<ViewName, { min: number; preferred: number }> = {
  performance: { min: 360, preferred: DECK_CHROME_H + DEFAULT_WAVE_H },
  edit: {
    min: EDIT_CHROME_H + 4 * EDIT_ROW_MIN_H,
    preferred: EDIT_CHROME_H + 4 * EDIT_ROW_H
  },
  editv2: {
    min: EDIT_CHROME_H + 4 * EDIT_ROW_MIN_H,
    preferred: EDIT_CHROME_H + 4 * EDIT_ROW_H
  },
  // The arrangement's chrome is a transport bar and a bar ruler, over lanes
  // shorter than an editing row.
  v3: {
    min: ARRANGEMENT_CHROME_H + 4 * ARRANGEMENT_LANE_H,
    preferred: ARRANGEMENT_CHROME_H + 4 * ARRANGEMENT_LANE_H
  }
}

function clampDeckHeight(height: number, view: ViewName): number {
  const { min } = VIEW_HEIGHTS[view]
  const max = window.innerHeight - TOOLBAR_H - HANDLE_H - MIN_BROWSER_H
  return clamp(height, min, Math.max(min, max))
}

function defaultHeights(): Record<ViewName, number> {
  const out = {} as Record<ViewName, number>
  for (const name of Object.keys(VIEW_HEIGHTS) as ViewName[]) {
    out[name] = clampDeckHeight(VIEW_HEIGHTS[name].preferred, name)
  }
  return out
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
      // A menu click is a press and an immediate release, so a preview started from
      // the cue point has something to end it.
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
  const [heights, setHeights] = useState(defaultHeights)
  const deckHeight = heights[view]
  const setDeckHeight = useCallback(
    (next: number | ((prev: number) => number)): void =>
      setHeights((prev) => {
        const value = typeof next === 'function' ? next(prev[view]) : next
        return prev[view] === value ? prev : { ...prev, [view]: value }
      }),
    [view]
  )
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

  // An AudioContext starts suspended until a gesture, and any click counts — a
  // waveform as much as a button.
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
    const onResize = (): void => setHeights((prev) => {
      const next = {} as Record<ViewName, number>
      for (const name of Object.keys(prev) as ViewName[]) next[name] = clampDeckHeight(prev[name], name)
      return next
    })
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

  const onHandleMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = drag.current
      if (!start) return
      setDeckHeight(clampDeckHeight(start.height + (event.clientY - start.pointerY), view))
    },
    [setDeckHeight, view]
  )

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
      <Busy />

      {view === 'v3' ? (
        <main className="edit-area">
          <ArrangementView />
        </main>
      ) : view === 'editv2' ? (
        <main className="edit-area">
          <EditV2View />
        </main>
      ) : view === 'edit' ? (
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
