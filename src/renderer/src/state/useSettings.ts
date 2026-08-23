import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DECK_IDS, type DeckId } from '@shared/types'
import type { EqMode } from '@shared/eq'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { clamp } from '@renderer/core/format'

/**
 * Waveform colouring.
 *
 * `3band` stacks blue lows, orange mids and white highs. `rgb` tints each
 * column by its frequency balance — red lows, green mids, blue highs, white
 * where all three are present. `mono` is a single envelope in the deck colour.
 */
export type WaveformColorMode = '3band' | 'rgb' | 'mono'

/**
 * Which view is on screen. `performance` is the two-deck rekordbox layout;
 * `edit` and `editv2` each stack four tracks for building an edit.
 */
export type ViewName = 'performance' | 'edit' | 'editv2'

/**
 * The decks a view shows. Focus and `Tab` stay inside this set, so the
 * performance view never lands on C or D — decks it does not draw and the DJ
 * could not see they were controlling.
 */
function decksInView(view: ViewName): readonly DeckId[] {
  return view === 'edit' || view === 'editv2' ? DECK_IDS : DECK_IDS.slice(0, 2)
}

/** App-wide preferences, persisted to localStorage. */
export interface SettingsState {
  /** Master output level, 0-1 linear. */
  masterVolume: number
  /** The deck unshifted keyboard shortcuts act on. */
  focusedDeck: DeckId
  /** Which view is on screen. See {@link ViewName}. */
  view: ViewName
  waveformColorMode: WaveformColorMode
  /** Whether the browser panel is at full height. */
  browserExpanded: boolean
  /**
   * How far a band EQ knob cuts. See {@link EqMode}.
   *
   * Global, not per deck, because that is how the hardware and rekordbox treat
   * it: a DJM's isolator switch changes the whole mixer. Per deck would be a
   * trap where one channel kills and the next one only drops 26 dB.
   */
  eqMode: EqMode
  setMasterVolume(linear: number): void
  setFocusedDeck(deck: DeckId): void
  setView(view: ViewName): void
  /**
   * `Tab` / `Shift+Tab` — move the focus by `step` decks, wrapping. Only the
   * decks the current view shows are in the ring, so this is still the plain
   * A/B swap in the performance view and walks all four in the editing view.
   */
  cycleFocusedDeck(step: number): void
  /** `Tab` — the next deck. Shorthand for `cycleFocusedDeck(1)`. */
  toggleFocusedDeck(): void
  setWaveformColorMode(mode: WaveformColorMode): void
  /** Switch the EQ floor. Every deck's EQ is re-applied at once. */
  setEqMode(mode: EqMode): void
  setBrowserExpanded(expanded: boolean): void
  toggleBrowserExpanded(): void
}

/**
 * Push the level at the audio graph. A value restored from localStorage at
 * startup has nothing to push to yet, so `useDecks.loadTrack` re-applies it
 * once the engine is initialised; that is what makes the setting survive a
 * restart rather than waiting for the fader to be touched.
 */
function applyMasterVolume(linear: number): void {
  try {
    AudioEngine.shared().setMasterVolume(linear)
  } catch (err) {
    // Building the context can fail outright when there is no output device.
    // The preference is still worth storing, so this must not throw at the UI.
    console.warn('[settings] master volume not applied', err)
  }
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      masterVolume: 0.8,
      focusedDeck: 'A',
      view: 'performance',
      waveformColorMode: '3band',
      browserExpanded: true,
      eqMode: 'eq',

      setMasterVolume(linear) {
        const level = clamp(linear, 0, 1)
        set({ masterVolume: level })
        applyMasterVolume(level)
      },

      setFocusedDeck(deck) {
        set({ focusedDeck: deck })
      },

      setView(view) {
        const decks = decksInView(view)
        // Carry the focus back into view when it is on a deck the new view does
        // not draw, or the unshifted keys would act on a deck nothing shows.
        const focusedDeck = decks.includes(get().focusedDeck) ? get().focusedDeck : decks[0]
        set({ view, focusedDeck })
      },

      cycleFocusedDeck(step) {
        const decks = decksInView(get().view)
        const at = decks.indexOf(get().focusedDeck)
        // An out-of-view focus reads as index -1; stepping from there still
        // lands somewhere sensible because the modulo is taken on the length.
        const next = (((at + step) % decks.length) + decks.length) % decks.length
        set({ focusedDeck: decks[next] })
      },

      toggleFocusedDeck() {
        get().cycleFocusedDeck(1)
      },

      setWaveformColorMode(mode) {
        set({ waveformColorMode: mode })
      },

      setEqMode(mode) {
        set({ eqMode: mode })
      },

      setBrowserExpanded(expanded) {
        set({ browserExpanded: expanded })
      },

      toggleBrowserExpanded() {
        set({ browserExpanded: !get().browserExpanded })
      }
    }),
    {
      name: 'djdaw.settings',
      version: 1,
      // Actions are not serialisable and would only bloat the stored blob.
      partialize: (s) => ({
        masterVolume: s.masterVolume,
        focusedDeck: s.focusedDeck,
        view: s.view,
        waveformColorMode: s.waveformColorMode,
        browserExpanded: s.browserExpanded,
        eqMode: s.eqMode
      })
    }
  )
)
