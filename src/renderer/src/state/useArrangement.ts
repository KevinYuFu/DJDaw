import { create } from 'zustand'
import type { ArrangementClip } from '@shared/arrangement'
import {
  MAX_TRACKS,
  START_TRACKS,
  fits,
  makeArrangementClipId,
  moveTrackTo,
  rateFor,
  selectAfterRemoving,
  toTimelineSec,
  trackDuration,
  voiceRegions
} from '@shared/arrangement'
import type { WaveformData } from '@shared/types'
import type { ChannelEq } from '@shared/eq'
import { flatChannel } from '@shared/eq'
import { FADER_UNITY, faderGain } from '@shared/fader'
import type { Deck } from '@renderer/audio/Deck'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { decodeTrack } from '@renderer/audio/decode'
import { resolveWaveform } from '@renderer/analysis/waveformFor'
import { useLibrary } from '@renderer/state/useLibrary'
import { useSettings } from '@renderer/state/useSettings'
import { secPerBar, snapToBar } from '@renderer/components/arrangement/timeline'

/**
 * The arrangement view's own state.
 *
 * It shares nothing with the decks: its tracks, its clips and the audio they
 * play are separate, and switching views carries nothing across. What it does
 * share is code — the same clip drawing, the same channel strip, the same
 * waveform cache.
 */

/** A file the arrangement has open, and everything drawn or played from it. */
export interface ArrangementSource {
  audioKey: string
  title: string
  buffer: AudioBuffer
  waveform: WaveformData | null
  durationSec: number
  /** The file's own tempo, which is what its speed on the timeline is set from. */
  bpm: number
  /** Where its first downbeat is, in file seconds. */
  firstBeatSec: number
}

const sources = new Map<string, ArrangementSource>()

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

/** Zoom levels, in pixels per second. */
export const ZOOM_LEVELS = [4, 8, 16, 32, 64, 128, 256] as const
const DEFAULT_ZOOM = 2
const DEFAULT_BPM = 120

export interface ArrangementState {
  trackIds: readonly string[]
  tracks: Readonly<Record<string, ArrangementTrack>>
  selectedTrackId: string | null
  selectedClipId: string | null
  /** One zoom and one scroll for every lane, so they stay lined up. */
  zoomIndex: number
  scrollSec: number
  /** The tempo the grid is built from, and every clip is locked to. */
  bpm: number
  /** Whether the first track dropped has set the tempo yet. */
  bpmFromTrack: boolean
  snap: boolean
  playing: boolean
  playheadSec: number

  addTrack(): void
  removeTrack(id: string): void
  selectTrack(id: string | null): void
  moveTrackTo(id: string, index: number): void
  setTrackEq(id: string, eq: ChannelEq): void
  setTrackFader(id: string, position: number): void
  /** Put a library track on a lane, locked to the arrangement's tempo. */
  dropTrack(trackId: string, libraryTrackId: string, atSec: number): Promise<void>
  removeClip(trackId: string, clipId: string): void
  selectClip(trackId: string, clipId: string | null): void
  setClips(trackId: string, clips: readonly ArrangementClip[]): void
  setBpm(bpm: number): void
  toggleSnap(): void
  setZoom(index: number): void
  setScroll(sec: number): void
  play(): void
  pause(): void
  seek(sec: number): void
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

/* ------------------------------------------------------------------ voices */

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
  return startedAt.sec + (AudioEngine.shared().ctx.currentTime - startedAt.ctxTime)
}

export function arrangementPlayhead(): number {
  return playheadNow()
}

/** The speed one file plays at on this arrangement. */
function rateOf(sourceId: string, bpm: number): number {
  const source = sources.get(sourceId)
  return source ? rateFor(source.bpm, bpm) : 1
}

/** Hand every voice its regions, its speed, its level and its EQ. */
async function syncVoices(): Promise<void> {
  const engine = AudioEngine.shared()
  await engine.init()
  const state = useArrangement.getState()
  const timeline = state.duration()
  const wanted = new Set<string>()

  for (const trackId of state.trackIds) {
    const track = state.tracks[trackId]
    if (!track) continue
    for (const sourceId of new Set(track.clips.map((c) => c.sourceId))) {
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
      const rate = rateOf(sourceId, state.bpm)
      voice.setRate(rate)
      voice.setGain(faderGain(track.fader))
      voice.setChannelEq(track.eq, useSettings.getState().eqMode)
      voice.setRegions(voiceRegions(track.clips, sourceId, timeline, rate))
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
  const bpm = useArrangement.getState().bpm
  for (const [key, voice] of voices) {
    // Each voice walks its own timeline at its own speed, so the moment it is
    // put at is scaled the same way its regions were.
    const sourceId = key.slice(key.lastIndexOf(':') + 1)
    voice.seekSeconds(sec * rateOf(sourceId, bpm))
    voice.play()
  }
  startedAt = { ctxTime: engine.ctx.currentTime, sec }
}

function stopVoices(): void {
  for (const voice of voices.values()) voice.pause()
  startedAt = null
}

export function refreshVoices(): void {
  void syncVoices()
}

/* ------------------------------------------------------------------- store */

export const useArrangement = create<ArrangementState>()((set, get) => ({
  ...startingTracks(),
  selectedTrackId: null,
  selectedClipId: null,
  zoomIndex: DEFAULT_ZOOM,
  scrollSec: 0,
  bpm: DEFAULT_BPM,
  bpmFromTrack: false,
  snap: true,
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
    set({
      trackIds: trackIds.filter((other) => other !== id),
      tracks: rest,
      selectedTrackId: selectedTrackId === id ? selectAfterRemoving(trackIds, id) : selectedTrackId,
      selectedClipId: null
    })
    refreshVoices()
  },

  selectTrack(id) {
    set({ selectedTrackId: id })
  },

  moveTrackTo(id, index) {
    const next = moveTrackTo(get().trackIds, id, index)
    if (next.every((other, i) => other === get().trackIds[i])) return
    set({ trackIds: next })
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
      const anchor = record.grid?.anchors?.[0]
      source = {
        audioKey: record.audioKey,
        title: record.title,
        buffer,
        waveform,
        durationSec: buffer.duration,
        bpm: anchor?.bpm ?? record.bpm ?? 0,
        firstBeatSec: anchor?.time ?? 0
      }
      sources.set(source.audioKey, source)
    }

    // The first file on the arrangement sets its tempo; everything after it is
    // locked to that, so no grid has to be adjusted by hand.
    if (!get().bpmFromTrack && source.bpm > 0) {
      set({ bpm: source.bpm, bpmFromTrack: true })
    }

    const bpm = get().bpm
    const rate = rateFor(source.bpm, bpm)
    // Placed so the file's own first downbeat lands on a bar line, with the
    // audio before it kept — dragging the clip's left edge out reveals it.
    const lead = toTimelineSec(source.firstBeatSec, rate)
    let startSec = snapToBar(Math.max(0, atSec) + lead, bpm) - lead
    while (startSec < -1e-9) startSec += secPerBar(bpm)

    const track = get().tracks[trackId]
    if (!track) return
    const clip: ArrangementClip = {
      id: makeArrangementClipId(),
      startSec,
      durationSec: toTimelineSec(source.durationSec, rate),
      sourceOffsetSec: 0,
      sourceId: source.audioKey,
      sourceDurationSec: source.durationSec,
      rate
    }
    // Dropped over something already there, it goes after it rather than
    // through it.
    if (!fits(track.clips, clip.id, clip.startSec, clip.durationSec)) {
      clip.startSec = snapToBar(trackDuration(track.clips), bpm)
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

  setBpm(bpm) {
    const next = Math.max(20, Math.min(300, bpm))
    if (!Number.isFinite(next) || next === get().bpm) return
    set({ bpm: next, bpmFromTrack: true })
    refreshVoices()
  },

  toggleSnap() {
    set({ snap: !get().snap })
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

  play() {
    if (get().playing) return
    void startVoices(get().playheadSec)
    set({ playing: true })
  },

  pause() {
    if (!get().playing) return
    const at = playheadNow()
    stopVoices()
    set({ playing: false, playheadSec: at })
  },

  seek(sec) {
    const at = Math.max(0, sec)
    set({ playheadSec: at })
    if (get().playing) void startVoices(at)
  },

  duration() {
    const { trackIds, tracks } = get()
    let end = 0
    for (const id of trackIds) end = Math.max(end, trackDuration(tracks[id].clips))
    return end
  }
}))
