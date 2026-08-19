import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { DeckId } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { clamp } from '@renderer/core/format'

/**
 * Detailed-waveform rendering style. `3band` is rekordbox's blue/orange/white
 * split; `mono` collapses the bands into a single envelope in the deck colour,
 * which is easier to read when scanning for arrangement rather than for drums.
 */
export type WaveformColorMode = '3band' | 'mono'

/** App-wide preferences, persisted to localStorage. */
export interface SettingsState {
  /** Master output level, 0-1 linear. */
  masterVolume: number
  /** The deck unshifted keyboard shortcuts act on. */
  focusedDeck: DeckId
  waveformColorMode: WaveformColorMode
  /** Whether the browser panel is at full height. */
  browserExpanded: boolean
  setMasterVolume(linear: number): void
  setFocusedDeck(deck: DeckId): void
  /** `Tab` — swap the focused deck. */
  toggleFocusedDeck(): void
  setWaveformColorMode(mode: WaveformColorMode): void
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
      waveformColorMode: '3band',
      browserExpanded: true,

      setMasterVolume(linear) {
        const level = clamp(linear, 0, 1)
        set({ masterVolume: level })
        applyMasterVolume(level)
      },

      setFocusedDeck(deck) {
        set({ focusedDeck: deck })
      },

      toggleFocusedDeck() {
        set({ focusedDeck: get().focusedDeck === 'A' ? 'B' : 'A' })
      },

      setWaveformColorMode(mode) {
        set({ waveformColorMode: mode })
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
        waveformColorMode: s.waveformColorMode,
        browserExpanded: s.browserExpanded
      })
    }
  )
)
