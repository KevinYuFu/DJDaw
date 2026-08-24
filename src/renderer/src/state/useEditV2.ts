import { create } from 'zustand'
import type { DeckId } from '@shared/types'
import { DECK_IDS } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { playbackRate } from '@renderer/analysis/playbackRate'
import { useDecks } from '@renderer/state/useDecks'
import { useLibrary } from '@renderer/state/useLibrary'

/**
 * The master tempo the editing V2 view lays everything out against.
 *
 * The first track loaded sets it. Every track after that is warped onto it, so
 * pressing play starts them all on the same grid rather than on their own.
 * Warping changes the speed without changing the pitch, so a 175 track at 150
 * still sounds like itself.
 */

/** The range a master tempo can be set to, by drag, by typing or by track. */
export const MASTER_BPM_MIN = 20
export const MASTER_BPM_MAX = 300

export function clampMasterBpm(bpm: number): number {
  return Math.min(MASTER_BPM_MAX, Math.max(MASTER_BPM_MIN, bpm))
}

export interface EditV2State {
  /** Null until the first track lands and names it. */
  masterBpm: number | null
  setMasterBpm(bpm: number): void
  /** Put a deck on the master tempo, setting that tempo if it is the first. */
  matchDeck(deck: DeckId): Promise<void>
  /** Put every loaded deck back on the master tempo. */
  matchAll(): Promise<void>
  /**
   * Start or stop every loaded row at once.
   *
   * There is no such thing as playing one row here: the point of the view is
   * hearing the tracks over each other, the way they are heard when they are
   * being mixed. Which row is picked changes nothing.
   */
  toggleAll(): void
}

/** Every row with a track on it. */
function loadedDecks(): DeckId[] {
  const decks = useDecks.getState().decks
  return DECK_IDS.filter((id) => decks[id].status === 'ready')
}

/** Whether any row is running. */
export function anyPlaying(decks: Record<DeckId, { playing: boolean }>): boolean {
  return DECK_IDS.some((id) => decks[id].playing)
}

/** The tempo a deck's audio is at now. */
function bpmOf(deck: DeckId): number {
  const state = useDecks.getState().decks[deck]
  if (!state.trackId) return 0
  const track = useLibrary.getState().trackById(state.trackId)
  return track?.grid?.anchors?.[0]?.bpm ?? track?.bpm ?? 0
}

export const useEditV2 = create<EditV2State>()((set, get) => ({
  masterBpm: null,

  setMasterBpm(bpm) {
    const next = clampMasterBpm(bpm)
    if (!Number.isFinite(next) || next === get().masterBpm) return
    set({ masterBpm: next })
    void get().matchAll()
  },

  async matchDeck(deck) {
    const state = useDecks.getState().decks[deck]
    if (state.status !== 'ready' || !state.trackId) return
    const trackBpm = bpmOf(deck)
    if (!(trackBpm > 0)) return

    // The first track to land names the tempo everything else is warped onto.
    if (get().masterBpm === null) set({ masterBpm: trackBpm })
    const master = get().masterBpm as number

    // Live: the deck reads its file faster or slower and a stretcher after it
    // puts the pitch back, so this takes effect on the next buffer and nothing
    // stops playing.
    const engine = AudioEngine.shared()
    await engine.init()
    engine.deck(deck).setWarp(playbackRate(trackBpm, master))
  },

  async matchAll() {
    for (const deck of DECK_IDS) await get().matchDeck(deck)
  },

  toggleAll() {
    const loaded = loadedDecks()
    if (loaded.length === 0) return
    // Through the store rather than the engine: it is what owns previews, loops
    // and the commanded playhead, and a row moved behind its back keeps them.
    const decks = useDecks.getState()
    if (loaded.some((id) => decks.decks[id].playing)) {
      for (const id of loaded) if (decks.decks[id].playing) decks.togglePlay(id)
      return
    }
    // A warped row runs through its own file faster or slower than the others,
    // so the moment they share is a moment on the master grid. Every row is put
    // on the lead row's, which is where it already is unless it was moved.
    const engine = AudioEngine.shared()
    const lead = engine.deck(loaded[0])
    const at = lead.positionSeconds() / lead.warpRate
    for (const id of loaded) {
      decks.seek(id, at * engine.deck(id).warpRate)
      decks.togglePlay(id)
    }
  }
}))
