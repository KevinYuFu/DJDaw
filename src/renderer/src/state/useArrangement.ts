import { create } from 'zustand'
import type { ArrangementClip } from '@shared/arrangement'
import {
  MAX_TRACKS,
  START_TRACKS,
  moveTrack,
  selectAfterRemoving,
  trackDuration
} from '@shared/arrangement'
import type { ChannelEq } from '@shared/eq'
import { flatChannel } from '@shared/eq'
import { FADER_UNITY } from '@shared/fader'

/**
 * The arrangement view's own state.
 *
 * It shares nothing with the decks: its tracks, its clips and the audio they
 * play are separate, and switching views carries nothing across. What it does
 * share is code — the same clip maths, the same channel strip, the same
 * waveform drawing.
 */

/** One lane. Its clips sit at places on the shared timeline, with gaps. */
export interface ArrangementTrack {
  id: string
  name: string
  clips: readonly ArrangementClip[]
  eq: ChannelEq
  /** Channel fader position, 0-1. */
  fader: number
}

/** How far apart the zoom levels sit, in pixels per second. */
export const ZOOM_LEVELS = [2, 4, 8, 16, 32, 64, 128] as const
const DEFAULT_ZOOM = 3

export interface ArrangementState {
  /** Top to bottom. */
  trackIds: readonly string[]
  tracks: Readonly<Record<string, ArrangementTrack>>
  selectedTrackId: string | null
  selectedClipId: string | null
  /** One zoom and one scroll for every lane, so they stay lined up. */
  zoomIndex: number
  scrollSec: number
  playing: boolean

  addTrack(): void
  removeTrack(id: string): void
  selectTrack(id: string | null): void
  /** Move the picked track up (-1) or down (1) the stack. */
  moveSelectedTrack(by: number): void
  renameTrack(id: string, name: string): void
  setTrackEq(id: string, eq: ChannelEq): void
  setTrackFader(id: string, position: number): void
  setZoom(index: number): void
  setScroll(sec: number): void
  /** How far the whole arrangement runs, which is its longest track. */
  duration(): number
}

let nextTrackId = 0

function makeTrack(): ArrangementTrack {
  nextTrackId += 1
  return {
    id: `at${nextTrackId}`,
    name: `Track ${nextTrackId}`,
    clips: [],
    eq: flatChannel(),
    fader: FADER_UNITY
  }
}

function startingTracks(): Pick<ArrangementState, 'trackIds' | 'tracks'> {
  const tracks: Record<string, ArrangementTrack> = {}
  const trackIds: string[] = []
  for (let i = 0; i < START_TRACKS; i++) {
    const track = makeTrack()
    tracks[track.id] = track
    trackIds.push(track.id)
  }
  return { trackIds, tracks }
}

export const useArrangement = create<ArrangementState>()((set, get) => ({
  ...startingTracks(),
  selectedTrackId: null,
  selectedClipId: null,
  zoomIndex: DEFAULT_ZOOM,
  scrollSec: 0,
  playing: false,

  addTrack() {
    const { trackIds, tracks } = get()
    if (trackIds.length >= MAX_TRACKS) return
    const track = makeTrack()
    set({
      trackIds: [...trackIds, track.id],
      tracks: { ...tracks, [track.id]: track },
      selectedTrackId: track.id
    })
  },

  removeTrack(id) {
    const { trackIds, tracks, selectedTrackId } = get()
    if (!tracks[id]) return
    const rest = { ...tracks }
    delete rest[id]
    const taking = selectedTrackId === id ? selectAfterRemoving(trackIds, id) : selectedTrackId
    set({
      trackIds: trackIds.filter((other) => other !== id),
      tracks: rest,
      selectedTrackId: taking,
      selectedClipId: null
    })
  },

  selectTrack(id) {
    set({ selectedTrackId: id })
  },

  moveSelectedTrack(by) {
    const { selectedTrackId, trackIds } = get()
    if (!selectedTrackId) return
    const next = moveTrack(trackIds, selectedTrackId, by)
    if (next.every((id, i) => id === trackIds[i])) return
    set({ trackIds: next })
  },

  renameTrack(id, name) {
    const track = get().tracks[id]
    if (!track) return
    set({ tracks: { ...get().tracks, [id]: { ...track, name } } })
  },

  setTrackEq(id, eq) {
    const track = get().tracks[id]
    if (!track) return
    set({ tracks: { ...get().tracks, [id]: { ...track, eq } } })
  },

  setTrackFader(id, position) {
    const track = get().tracks[id]
    if (!track) return
    const next = Math.max(0, Math.min(1, position))
    if (track.fader === next) return
    set({ tracks: { ...get().tracks, [id]: { ...track, fader: next } } })
  },

  setZoom(index) {
    const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, Math.round(index)))
    if (next === get().zoomIndex) return
    set({ zoomIndex: next })
  },

  setScroll(sec) {
    const next = Math.max(0, sec)
    if (next === get().scrollSec) return
    set({ scrollSec: next })
  },

  duration() {
    const { trackIds, tracks } = get()
    let end = 0
    for (const id of trackIds) end = Math.max(end, trackDuration(tracks[id].clips))
    return end
  }
}))
