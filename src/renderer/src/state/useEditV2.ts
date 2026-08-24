import { create } from 'zustand'
import type { DeckId } from '@shared/types'
import { DECK_IDS } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { needsWarp, warpBuffer } from '@renderer/analysis/warp'
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

export interface EditV2State {
  /** Null until the first track lands and names it. */
  masterBpm: number | null
  /** The decks being warped right now, so a row can say so. */
  warping: Readonly<Record<string, boolean>>
  setMasterBpm(bpm: number): void
  /** Put a deck on the master tempo, setting that tempo if it is the first. */
  matchDeck(deck: DeckId): Promise<void>
  /** Put every loaded deck back on the master tempo. */
  matchAll(): Promise<void>
}

/** What each deck's audio was before it was warped, so a re-warp starts clean. */
const original = new Map<DeckId, { trackId: string; buffer: AudioBuffer; bpm: number }>()

/** The tempo a deck's audio is at now. */
function bpmOf(deck: DeckId): number {
  const state = useDecks.getState().decks[deck]
  if (!state.trackId) return 0
  const track = useLibrary.getState().trackById(state.trackId)
  return track?.grid?.anchors?.[0]?.bpm ?? track?.bpm ?? 0
}

export const useEditV2 = create<EditV2State>()((set, get) => ({
  masterBpm: null,
  warping: {},

  setMasterBpm(bpm) {
    const next = Math.max(20, Math.min(300, bpm))
    if (!Number.isFinite(next) || next === get().masterBpm) return
    set({ masterBpm: next })
    void get().matchAll()
  },

  async matchDeck(deck) {
    const state = useDecks.getState().decks[deck]
    if (state.status !== 'ready' || !state.trackId || !state.buffer) return
    const trackBpm = bpmOf(deck)
    if (!(trackBpm > 0)) return

    // The first track to land names the tempo everything else is warped onto.
    if (get().masterBpm === null) {
      set({ masterBpm: trackBpm })
      original.set(deck, { trackId: state.trackId, buffer: state.buffer, bpm: trackBpm })
      return
    }
    const master = get().masterBpm as number

    // Warping always starts from the audio as it was recorded, so changing the
    // master tempo twice does not stretch an already stretched file.
    const held = original.get(deck)
    const source =
      held && held.trackId === state.trackId
        ? held
        : { trackId: state.trackId, buffer: state.buffer, bpm: trackBpm }
    original.set(deck, source)

    if (!needsWarp(source.bpm, master)) {
      if (state.buffer !== source.buffer) useDecks.getState().replaceAudio(deck, source.buffer)
      return
    }
    if (get().warping[deck]) return

    set({ warping: { ...get().warping, [deck]: true } })
    try {
      const engine = AudioEngine.shared()
      await engine.init()
      const warped = await warpBuffer(engine.ctx, source.buffer, source.bpm, master)
      // The row may have been unloaded or reloaded while the worker was busy.
      const now = useDecks.getState().decks[deck]
      if (now.trackId === source.trackId) useDecks.getState().replaceAudio(deck, warped)
    } catch (err) {
      console.error('[editv2] warp failed', err)
    } finally {
      const rest = { ...get().warping }
      delete rest[deck]
      set({ warping: rest })
    }
  },

  async matchAll() {
    for (const deck of DECK_IDS) await get().matchDeck(deck)
  }
}))
