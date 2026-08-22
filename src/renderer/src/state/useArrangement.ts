import { create } from 'zustand'
import type { ArrangementClip } from '@shared/arrangement'
import {
  MAX_TRACKS,
  START_TRACKS,
  fits,
  makeArrangementClipId,
  voiceRegions,
  moveTrack,
  selectAfterRemoving,
  trackDuration
} from '@shared/arrangement'
import type { WaveformData } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { decodeTrack } from '@renderer/audio/decode'
import { resolveWaveform } from '@renderer/analysis/waveformFor'
import type { Deck } from '@renderer/audio/Deck'
import { useLibrary } from '@renderer/state/useLibrary'
import { useSettings } from '@renderer/state/useSettings'
import type { ChannelEq } from '@shared/eq'
import { flatChannel } from '@shared/eq'
import { FADER_UNITY, faderGain } from '@shared/fader'

/**
 * The arrangement view's own state.
 *
 * It shares nothing with the decks: its tracks, its clips and the audio they
 * play are separate, and switching views carries nothing across. What it does
 * share is code — the same clip maths, the same channel strip, the same
 * waveform drawing.
 */

/**
 * A file the arrangement has open, and everything drawn or played from it.
 *
 * Held by audio key, so the same file dropped on two tracks is decoded once.
 */
export interface ArrangementSource {
  audioKey: string
  path: string
  title: string
  buffer: AudioBuffer
  waveform: WaveformData | null
  durationSec: number
}

const sources = new Map<string, ArrangementSource>()

/**
 * One engine deck per track and file.
 *
 * A deck holds one file, so a track whose clips come from two files needs two
 * of these. A track's clips never overlap, so at most one of its voices is
 * making a sound at any moment and giving them all the same level and EQ is
 * exactly one channel.
 */
const voices = new Map<string, Deck>()
let startedAt: { ctxTime: number; sec: number } | null = null

function voiceKey(trackId: string, sourceId: string): string {
  return `arr:${trackId}:${sourceId}`
}

/** Where the playhead is now, following the clock while it is running. */
function playheadNow(): number {
  const state = useArrangement.getState()
  if (!state.playing || !startedAt) return state.playheadSec
  const engine = AudioEngine.shared()
  return startedAt.sec + (engine.ctx.currentTime - startedAt.ctxTime)
}

/** Hand every voice its regions, its level and its EQ. */
async function syncVoices(): Promise<void> {
  const engine = AudioEngine.shared()
  await engine.init()
  const state = useArrangement.getState()
  const timeline = state.duration()
  const wanted = new Set<string>()

  for (const trackId of state.trackIds) {
    const track = state.tracks[trackId]
    if (!track) continue
    const ids = new Set(track.clips.map((c) => c.sourceId))
    for (const sourceId of ids) {
      const source = sources.get(sourceId)
      if (!source) continue
      const key = voiceKey(trackId, sourceId)
      wanted.add(key)
      let voice = voices.get(key)
      if (!voice) {
        voice = engine.namedDeck(key)
        voice.load(source.buffer)
        voices.set(key, voice)
      }
      voice.setGain(faderGain(track.fader))
      voice.setChannelEq(track.eq, useSettings.getState().eqMode)
      voice.setRegions(voiceRegions(track.clips, sourceId, timeline))
    }
  }

  for (const key of [...voices.keys()]) {
    if (wanted.has(key)) continue
    voices.delete(key)
    engine.dropNamedDeck(key)
  }
}

/** Put every voice at the same moment and let them go together. */
async function startVoices(sec: number): Promise<void> {
  const engine = AudioEngine.shared()
  await engine.init()
  await engine.resume()
  await syncVoices()
  for (const voice of voices.values()) {
    voice.seekSeconds(sec)
    voice.play()
  }
  startedAt = { ctxTime: engine.ctx.currentTime, sec }
}

function stopVoices(): void {
  for (const voice of voices.values()) voice.pause()
  startedAt = null
}

/** The playhead, for anything drawing it. */
export function arrangementPlayhead(): number {
  return playheadNow()
}

/** Push whatever changed on a track out to its voices. */
export function refreshVoices(): void {
  void syncVoices()
}

/** The audio and envelope for a file the arrangement has open. */
export function arrangementSource(sourceId: string): ArrangementSource | null {
  return sources.get(sourceId) ?? null
}

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
  /** Where the one playhead is, in seconds. */
  playheadSec: number

  addTrack(): void
  removeTrack(id: string): void
  selectTrack(id: string | null): void
  /** Move the picked track up (-1) or down (1) the stack. */
  moveSelectedTrack(by: number): void
  renameTrack(id: string, name: string): void
  setTrackEq(id: string, eq: ChannelEq): void
  setTrackFader(id: string, position: number): void
  /**
   * Put a library track on a lane as one clip, starting at `atSec`.
   *
   * The file is decoded and analysed the first time it is used and kept after
   * that, so dropping the same track again is instant.
   */
  dropTrack(trackId: string, libraryTrackId: string, atSec: number): Promise<void>
  /** Take a clip off its lane. */
  removeClip(trackId: string, clipId: string): void
  selectClip(trackId: string, clipId: string | null): void
  /** Replace a lane's clips, for the drags that rearrange them. */
  setClips(trackId: string, clips: readonly ArrangementClip[]): void
  /** Start every track from the playhead. */
  play(): void
  pause(): void
  seek(sec: number): void
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
  playheadSec: 0,

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
    refreshVoices()
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
    refreshVoices()
  },

  setTrackFader(id, position) {
    const track = get().tracks[id]
    if (!track) return
    const next = Math.max(0, Math.min(1, position))
    if (track.fader === next) return
    set({ tracks: { ...get().tracks, [id]: { ...track, fader: next } } })
    refreshVoices()
  },

  async dropTrack(trackId, libraryTrackId, atSec) {
    if (!get().tracks[trackId]) return
    const record = useLibrary.getState().trackById(libraryTrackId)
    if (!record) return

    let source = sources.get(record.audioKey)
    if (!source) {
      const engine = AudioEngine.shared()
      await engine.init()
      await engine.resume()
      const buffer = await decodeTrack(engine.ctx, record.path)
      const waveform = await resolveWaveform(record.audioKey, record.path, buffer)
      source = {
        audioKey: record.audioKey,
        path: record.path,
        title: record.title,
        buffer,
        waveform,
        durationSec: buffer.duration
      }
      sources.set(source.audioKey, source)
    }

    const track = get().tracks[trackId]
    if (!track) return
    const clip: ArrangementClip = {
      id: makeArrangementClipId(),
      startSec: Math.max(0, atSec),
      durationSec: source.durationSec,
      sourceOffsetSec: 0,
      sourceId: source.audioKey,
      sourceDurationSec: source.durationSec
    }
    // Dropped over something already there, it goes after it rather than
    // through it.
    if (!fits(track.clips, clip.id, clip.startSec, clip.durationSec)) {
      clip.startSec = trackDuration(track.clips)
    }
    set({
      tracks: { ...get().tracks, [trackId]: { ...track, clips: [...track.clips, clip] } },
      selectedTrackId: trackId,
      selectedClipId: clip.id
    })
    refreshVoices()
  },

  removeClip(trackId, clipId) {
    const track = get().tracks[trackId]
    if (!track) return
    set({
      tracks: {
        ...get().tracks,
        [trackId]: { ...track, clips: track.clips.filter((c) => c.id !== clipId) }
      },
      selectedClipId: get().selectedClipId === clipId ? null : get().selectedClipId
    })
    refreshVoices()
  },

  selectClip(trackId, clipId) {
    set({ selectedTrackId: trackId, selectedClipId: clipId })
  },

  setClips(trackId, clips) {
    const track = get().tracks[trackId]
    if (!track) return
    set({ tracks: { ...get().tracks, [trackId]: { ...track, clips: [...clips] } } })
    refreshVoices()
  },

  play() {
    const state = get()
    if (state.playing) return
    void startVoices(state.playheadSec)
    set({ playing: true })
  },

  pause() {
    if (!get().playing) return
    stopVoices()
    set({ playing: false, playheadSec: playheadNow() })
  },

  seek(sec) {
    const at = Math.max(0, sec)
    set({ playheadSec: at })
    if (get().playing) void startVoices(at)
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
