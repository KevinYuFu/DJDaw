import { create } from 'zustand'
import { DECK_IDS } from '@shared/types'
import type { BeatGrid, DeckId, HotCue, Track, WaveformData } from '@shared/types'
import {
  deleteSegment,
  dropIndex,
  reorderClip,
  splitAt,
  timelineDuration,
  toRegions,
  wholeTrackClip
} from '@shared/clips'
import type { Clip } from '@shared/clips'
import { CENTRE, flatChannel, isFlat } from '@shared/eq'
import { FADER_UNITY, crossfadeGainFor, faderGain } from '@shared/fader'
import type { ChannelEq } from '@shared/eq'
import { nearestPoint, nextPoint, pointsOfInterest, prevPoint } from '@shared/pointsOfInterest'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import type { Deck } from '@renderer/audio/Deck'
import { decodeTrack } from '@renderer/audio/decode'
import { resolveWaveform } from '@renderer/analysis/waveformCache'
import { detectTempo } from '@renderer/analysis/bpm'
import {
  beatAtTime,
  beatJumpTime,
  makeGrid,
  nearestBeatTime,
  nudgeGrid as nudgeGridBy,
  scaleGridBpm,
  setBpmAt,
  setDownbeatAt,
  timeAtBeat
} from '@renderer/core/beatgrid'
import {
  BEAT_JUMP_SIZES,
  DEFAULT_BEAT_JUMP,
  DEFAULT_ZOOM_INDEX,
  HOT_CUE_COLORS,
  HOT_CUE_COUNT,
  LOOP_SIZES,
  TEMPO_RANGES,
  WAVE_ZOOM_LEVELS
} from '@renderer/core/constants'
import { clamp } from '@renderer/core/format'
import { useLibrary } from '@renderer/state/useLibrary'
import { useSettings } from '@renderer/state/useSettings'

/**
 * Every deck and everything the transport does.
 *
 * The playhead is not in here. Actions that need the live position ask the
 * engine for it with `Deck.positionSeconds()`, so almost none of them take a
 * time argument and nothing in this file runs a rAF loop.
 *
 * Persisted per-track data — cues, grid, BPM — lives in `useLibrary`, the
 * single source of truth, and is read and written back there.
 */
export interface DeckState {
  trackId: string | null
  status: 'empty' | 'loading' | 'ready'
  playing: boolean
  /**
   * True only while a hot cue pad or CUE is held down on a stopped deck.
   *
   * The deck is making sound either way, so `playing` alone cannot tell a
   * momentary preview from real playback — and the transport must not light up
   * PLAY for a gesture the DJ is about to let go of.
   */
  previewing: boolean
  /** Tempo fader position in percent, -tempoRange..+tempoRange. */
  pitchPercent: number
  tempoRange: number
  /** UI only until there is a time-stretcher; the engine ignores it. */
  keyLock: boolean
  quantize: boolean
  beatJumpBeats: number
  loopBeats: number
  /** Kept with `active: false` after a loop exits, so the UI can re-loop it. */
  loop: { active: boolean; startSec: number; endSec: number } | null
  zoomIndex: number
  /** Waveform data. Held here, not in the library store, for its size. */
  waveform: WaveformData | null
  /** The AudioBuffer stays here so analysis and export can reach it. */
  buffer: AudioBuffer | null
  /**
   * The pieces this deck plays, in timeline order.
   *
   * A freshly loaded deck is one clip covering the whole file. Cutting turns
   * it into a timeline, and from then on a position along the deck is no
   * longer a position in the source audio — `sourceTimeAt` does that
   * conversion. Every deck carries one, the two performance decks included, so
   * playback and drawing take a single path.
   */
  clips: Clip[]
  /** The clip the edit view has selected, or null. */
  selectedClipId: string | null
  /**
   * Trim, three-band EQ and filter positions for this channel, 0.5 flat.
   *
   * Session state belonging to the channel, not the track: it outlives a track
   * swap. Ejecting the deck clears it.
   */
  eq: ChannelEq
  /**
   * Channel fader travel, 0 at the bottom and 1 at the top, silent to +6 dB.
   *
   * Session state like the EQ, so it outlives a track swap. Both views drive
   * this one value: two of them would fight over the deck's gain, and whichever
   * mounted last would win.
   */
  fader: number
}

/** Whether a cut happened, and if not, short plain text saying why. */
export interface CutResult {
  ok: boolean
  reason?: string
}

export interface DecksState {
  decks: Record<DeckId, DeckState>
  /** Crossfader, 0 full A and 1 full B. Only decks A and B are on it. */
  crossfade: number
  loadTrack(deck: DeckId, trackId: string): Promise<void>
  /**
   * Eject: stop the deck, drop its audio and put it back to empty. Also how a
   * deck recovers when its track leaves the library.
   */
  unloadDeck(deck: DeckId): void
  togglePlay(deck: DeckId): void
  /**
   * CUE pressed, with CDJ semantics: playing goes back to the cue point and
   * pauses; paused on the cue point previews until {@link cueRelease}; paused
   * anywhere else sets the cue point here.
   */
  cuePress(deck: DeckId): void
  cueRelease(deck: DeckId): void
  /**
   * End whatever preview this deck is running, exactly as releasing the pad
   * does. A no-op on a deck that is not previewing.
   *
   * Every route out of a preview goes through here, including the UI's safety
   * net for a release that lands off the pad or never arrives at all: a
   * pointer that comes up somewhere else still ends the gesture, so a preview
   * can never outlive the press that started it.
   */
  endPreview(deck: DeckId): void
  seek(deck: DeckId, sec: number): void
  beatJump(deck: DeckId, beats: number): void
  setPitch(deck: DeckId, percent: number): void
  setTempoRange(deck: DeckId, range: number): void
  toggleQuantize(deck: DeckId): void
  toggleKeyLock(deck: DeckId): void
  setBeatJumpBeats(deck: DeckId, beats: number): void
  setZoom(deck: DeckId, index: number): void
  setHotCue(deck: DeckId, index: number): void
  triggerHotCue(deck: DeckId, index: number): void
  /** Pad released — ends a held preview and parks on that hot cue point. */
  releaseHotCue(deck: DeckId, index: number): void
  deleteHotCue(deck: DeckId, index: number): void
  addMemoryCue(deck: DeckId): void
  /**
   * Delete the locator nearest the playhead, and only if one is genuinely
   * close. Nothing near enough means nothing is deleted, which is the safe
   * answer: a marker somewhere else in the track is not what the key meant.
   */
  deleteMemoryCueAt(deck: DeckId): void
  /**
   * Jump to the next point of interest — locator, hot cue or the CUE point —
   * to the right (`1`) or the left (`-1`). Playing decks keep rolling from
   * there; stopped decks park on it. Nothing to jump to is a no-op.
   */
  jumpToPoint(deck: DeckId, direction: 1 | -1): void
  nudgeGrid(deck: DeckId, beatFraction: number): void
  setDownbeatHere(deck: DeckId): void
  setGridBpm(deck: DeckId, bpm: number): void
  scaleGrid(deck: DeckId, factor: number): void
  tapTempo(deck: DeckId): void
  toggleLoop(deck: DeckId): void
  setLoopBeats(deck: DeckId, beats: number): void
  /**
   * Cut the clip under the playhead in two. Snaps to the grid first when
   * Quantize is on.
   *
   * A refusal comes back with its reason, for the button to show.
   */
  cutAtPlayhead(deck: DeckId): CutResult
  selectClip(deck: DeckId, clipId: string | null): void
  /**
   * Delete the selected piece.
   *
   * From the middle of a row this leaves a hole of the same length and selects
   * it, so pressing delete again closes the row up. At either end the piece
   * simply goes.
   */
  deleteSelectedClip(deck: DeckId): void
  /**
   * Move a clip to a new place on the row, letting it overwrite whatever it
   * lands on the way a DAW does. Snaps to the grid first when Quantize is on,
   * exactly as cutting does.
   *
   * This is what a drag in the MACRO view commits on release.
   */
  moveClipTo(deck: DeckId, clipId: string, toStartSec: number): void
  /**
   * Put a piece at a place in the order.
   *
   * Driven straight from a drag: the row rearranges under the hand, so the
   * drop does what is already on screen.
   */
  reorderClipTo(deck: DeckId, clipId: string, index: number): void
  /** Move one channel knob. `value` is a 0-1 position, 0.5 flat. */
  /** Move the channel fader. See {@link DeckState.fader}. */
  setFader(deck: DeckId, position: number): void
  setCrossfade(position: number): void
  setChannelKnob(deck: DeckId, knob: keyof ChannelEq, value: number): void
  /** Put one knob back to centre. What a double-click on a knob does. */
  resetChannelKnob(deck: DeckId, knob: keyof ChannelEq): void
  /** Put the whole channel back to flat. */
  resetChannelEq(deck: DeckId): void
}

/** Short, plain text for a cut that did nothing. */
const CUT_REFUSALS: Record<'gap' | 'too-short', string> = {
  gap: 'No clip here',
  'too-short': 'Too close to a cut'
}

/**
 * One beat at 120 BPM. Only used before a track has been gridded: there is no
 * phase to preserve yet, so a nominal-tempo step is the best guess available
 * and keeps beat jump and loops usable while analysis is still running.
 */
const UNGRIDDED_BEAT_SEC = 0.5

/**
 * How close to the cue point counts as "on the cue point" for CUE preview.
 *
 * Deliberately far wider than the playhead's own accuracy. The worklet reports
 * its state every three render quanta — around 8 ms — so a position read
 * between two reports can disagree with where the deck actually is by more
 * than a couple of milliseconds. The two ways of being wrong are not
 * symmetrical: reading "not on the cue point" by mistake destroys the saved
 * cue point, while reading it the other way only previews a press the DJ can
 * repeat. So the window is one that report jitter cannot cross, and still an
 * order of magnitude shorter than a beat.
 */
const CUE_TOLERANCE_SEC = 0.02

/** Taps further apart than this start a new tempo measurement. */
const TAP_TIMEOUT_MS = 2000
const TAP_HISTORY = 8

/** Transport state that changes on every press but must not re-render the UI. */
interface DeckRuntime {
  /**
   * Where a held preview parks when it is released: the point it is playing
   * from, not where the playhead was before, which is what CDJ hardware does.
   */
  previewReturnSec: number | null
  /** Hot cue pad currently held as a preview, or null. */
  previewCueIndex: number | null
  /** True while CUE is held as a preview from the cue point. */
  cuePreview: boolean
  /** Tap timestamps, newest last. */
  taps: number[]
  /** Bumped on every load so a slow decode cannot land on a newer track. */
  loadToken: number
  /**
   * Where the store last told the playhead to go, or null once the deck has
   * moved on under its own power. CUE trusts this over the reported position;
   * see {@link CUE_TOLERANCE_SEC}.
   */
  commandedSec: number | null
  /** Whether this deck's engine listeners have been attached yet. */
  watching: boolean
}

function newRuntime(): DeckRuntime {
  return {
    previewReturnSec: null,
    previewCueIndex: null,
    cuePreview: false,
    taps: [],
    loadToken: 0,
    commandedSec: null,
    watching: false
  }
}

/**
 * One value per deck. The ids come from `DECK_IDS` so adding a deck is a
 * one-line change there, not a hunt through this file for hard-coded ids.
 */
function perDeck<T>(make: () => T): Record<DeckId, T> {
  const out = {} as Record<DeckId, T>
  for (const id of DECK_IDS) out[id] = make()
  return out
}

const runtime: Record<DeckId, DeckRuntime> = perDeck(newRuntime)

function emptyDeck(): DeckState {
  return {
    trackId: null,
    status: 'empty',
    playing: false,
    previewing: false,
    pitchPercent: 0,
    tempoRange: TEMPO_RANGES[0],
    keyLock: false,
    quantize: true,
    beatJumpBeats: DEFAULT_BEAT_JUMP,
    loopBeats: 4,
    loop: null,
    zoomIndex: DEFAULT_ZOOM_INDEX,
    waveform: null,
    buffer: null,
    clips: [],
    selectedClipId: null,
    eq: flatChannel(),
    fader: FADER_UNITY
  }
}

function patchDeck(id: DeckId, patch: Partial<DeckState>): void {
  useDecks.setState((s) => {
    const decks: Record<DeckId, DeckState> = { ...s.decks }
    decks[id] = { ...decks[id], ...patch }
    return { decks }
  })
}

/**
 * Forget that this deck's playback is a preview: the return position, the pad
 * that owns it, and the flag the UI reads. It does not touch the transport, so
 * it is equally the way a preview ends and the way one is promoted to real
 * playback — the caller decides which by what it does with the deck after.
 */
function clearPreview(id: DeckId): void {
  const rt = runtime[id]
  rt.previewReturnSec = null
  rt.previewCueIndex = null
  rt.cuePreview = false
  if (useDecks.getState().decks[id].previewing) patchDeck(id, { previewing: false })
}

/**
 * Everything an action needs about a deck, or null when there is nothing
 * loaded to act on. `position` is sampled once here so a single action always
 * works from one consistent playhead reading.
 */
interface DeckContext {
  id: DeckId
  state: DeckState
  track: Track
  deck: Deck
  grid: BeatGrid | null
  position: number
}

function context(id: DeckId): DeckContext | null {
  const state = useDecks.getState().decks[id]
  if (state.status !== 'ready' || !state.trackId) return null
  // Either collection: a deck can hold a mirrored track until the first edit
  // forks it, and the fork has a different id.
  const track = useLibrary.getState().trackById(state.trackId)
  if (!track) return null
  const deck = AudioEngine.shared().deck(id)
  return { id, state, track, deck, grid: track.grid, position: deck.positionSeconds() }
}

/** Snap to the nearest beat when Quantize is on and the track has a grid. */
function snapped(ctx: DeckContext, time: number): number {
  return ctx.state.quantize && ctx.grid ? nearestBeatTime(ctx.grid, time) : time
}

function trackDuration(ctx: DeckContext): number {
  return ctx.state.buffer?.duration ?? ctx.track.durationSec
}

/**
 * Seeking never starts or stops the deck, but it can end a loop: a jump out of
 * the looped region leaves the loop.
 */
function seekDeck(ctx: DeckContext, sec: number): void {
  const target = clamp(sec, 0, trackDuration(ctx))
  exitLoopIfOutside(ctx.id, ctx.deck, target)
  ctx.deck.seekSeconds(target)
  runtime[ctx.id].commandedSec = target
}

/**
 * Leave an active loop when the playhead is sent outside it. The worklet wraps
 * the position by the loop length, so without this a click past the loop end
 * lands back inside the loop and the deck looks like it ignored the click.
 */
function exitLoopIfOutside(id: DeckId, deck: Deck, target: number): void {
  // The live loop, not the one captured in the context: a loop hot cue arms
  // its loop and then seeks into it within a single action.
  const loop = useDecks.getState().decks[id].loop
  if (!loop?.active) return
  if (target >= loop.startSec && target < loop.endSec) return
  deck.setLoop(false, 0, 0)
  // The bounds survive so the UI can re-loop, exactly as toggleLoop leaves them.
  patchDeck(id, { loop: { ...loop, active: false } })
}

/** Start playback, forgetting the commanded position the deck is leaving. */
function playDeck(ctx: DeckContext): void {
  runtime[ctx.id].commandedSec = null
  ctx.deck.play()
}

/**
 * Is a paused deck sitting on the cue point?
 *
 * Judged from where the deck was commanded to as well as from what it
 * reported, since a report can be a whole interval out of date. The commanded
 * position counts only while the reported one still agrees with it, so a jog
 * scrub cannot keep it alive.
 */
function atCuePoint(ctx: DeckContext, cue: number): boolean {
  if (Math.abs(ctx.position - cue) <= CUE_TOLERANCE_SEC) return true
  const commanded = runtime[ctx.id].commandedSec
  if (commanded == null) return false
  return (
    Math.abs(commanded - cue) <= CUE_TOLERANCE_SEC &&
    Math.abs(ctx.position - commanded) <= CUE_TOLERANCE_SEC
  )
}

/** Time `beats` grid beats after `startSec`. */
function beatsAfter(grid: BeatGrid | null, startSec: number, beats: number): number {
  if (!grid) return startSec + beats * UNGRIDDED_BEAT_SEC
  return timeAtBeat(grid, beatAtTime(grid, startSec) + beats)
}

/**
 * How far from the playhead a marker still counts as the one the DJ means:
 * one beat, or {@link UNGRIDDED_BEAT_SEC} on a track with no grid yet.
 *
 * A beat is the resolution locators are dropped at, since quantize snaps them
 * to the grid. Anything further away is a different marker.
 */
function pointWindow(ctx: DeckContext): number {
  return beatsAfter(ctx.grid, ctx.position, 1) - ctx.position
}

/**
 * Edit a deck's track, following the record the edit landed on.
 *
 * The first write to a mirrored track forks it into the local collection, so
 * the id the deck holds stops carrying its cues and grid. The returned id is
 * adopted here to keep the two in step.
 *
 * The re-point is conditional: the deck may have been ejected or loaded with
 * something else while an async caller was away.
 */
function writeTrack(id: DeckId, trackId: string, patch: Partial<Track>): string | null {
  const written = useLibrary.getState().updateTrack(trackId, patch)
  if (written && written !== trackId && useDecks.getState().decks[id].trackId === trackId) {
    patchDeck(id, { trackId: written })
  }
  return written
}

function writeGrid(ctx: DeckContext, grid: BeatGrid): void {
  writeTrack(ctx.id, ctx.track.id, { grid, bpm: grid.anchors[0].bpm })
}

function writeHotCues(ctx: DeckContext, cues: HotCue[]): void {
  writeTrack(ctx.id, ctx.track.id, { hotCues: [...cues].sort((a, b) => a.index - b.index) })
}

/**
 * Store a new set of clips and hand the engine the regions they describe.
 *
 * Clips are per-deck session state, not track data, so nothing here goes
 * through {@link writeTrack}: cutting must not fork a rekordbox mirror track.
 * There is nothing about the file to write down — the same track loaded on two
 * decks is cut differently on each — and a fork would split the cues and grid
 * off from the record the browser is showing for no gain at all.
 */
function setClips(ctx: DeckContext, clips: Clip[], patch: Partial<DeckState> = {}): void {
  patchDeck(ctx.id, { ...patch, clips })
  ctx.deck.setRegions(toRegions(clips))
}

/**
 * Store a channel's knob positions and hand the whole set to the engine.
 *
 * Like clips, EQ is per-deck session state and not track data, so nothing here
 * goes through {@link writeTrack}: turning a knob must not fork a rekordbox
 * mirrored track. There is nothing about the file to write down — the same
 * track loaded on two decks is EQ'd differently on each — and a fork would
 * split the cues and grid off from the record the browser is showing.
 *
 * The engine only hears about it once it has handed this deck out; `deck()`
 * throws before that, so knobs moved on an empty deck are pushed by the next
 * load instead.
 */
function setEq(id: DeckId, eq: ChannelEq): void {
  patchDeck(id, { eq })
  applyEq(id, eq)
}

/**
 * Hand one channel's knobs to the engine at the current EQ mode.
 *
 * The mode is a global preference, read here from {@link useSettings}'s
 * `eqMode`. Nothing is written to the store, so this is also how a mode change
 * reaches a channel whose knobs have not moved.
 */
function applyEq(id: DeckId, eq: ChannelEq): void {
  if (!runtime[id].watching) return
  AudioEngine.shared().deck(id).setChannelEq(eq, useSettings.getState().eqMode)
}

/**
 * Push a deck's level: its own fader, times its share of the crossfader.
 *
 * One place computes this. Two of them — a view each — would each push a level
 * that left the other's out, and whichever ran last would win.
 */
function applyFader(id: DeckId): void {
  const s = useDecks.getState()
  try {
    AudioEngine.shared()
      .deck(id)
      .setGain(faderGain(s.decks[id].fader) * crossfadeGainFor(id, s.crossfade))
  } catch {
    // Nothing to push to before the engine exists; `loadTrack` re-applies it.
  }
}

/**
 * Mirror the engine's own view of playback into the store. The worklet is the
 * authority — it is what actually stops at the end of the file — so the
 * optimistic `playing` flags the actions set are corrected from here.
 */
function watchDeck(id: DeckId, deck: Deck): void {
  if (runtime[id].watching) return
  runtime[id].watching = true
  deck.onState((s) => {
    if (useDecks.getState().decks[id].playing !== s.playing) patchDeck(id, { playing: s.playing })
  })
  deck.onEnded(() => {
    // Running off the end stops the deck without any release, so the preview
    // ends here too, along with the position it would return to.
    clearPreview(id)
    patchDeck(id, { playing: false })
  })
}

/**
 * The track's grid, detecting and persisting one the first time it is loaded.
 *
 * Persisting is a write like any other, so detecting a grid for a mirrored
 * track forks it. That is the right trade even though no pad was pressed: a
 * detected grid is worth keeping, and rekordbox tracks nearly always arrive
 * gridded, so the fork only happens for the ones rekordbox never analysed.
 */
async function resolveGrid(id: DeckId, track: Track, buffer: AudioBuffer): Promise<BeatGrid | null> {
  if (track.grid) return track.grid
  try {
    const { bpm, firstBeatTime } = await detectTempo(buffer)
    // Detection takes seconds, and the snapshot it started from is that old.
    // In the meantime the DJ may have gridded the track by hand, or the other
    // deck may have finished detecting the same file. Whatever grid exists now
    // wins: a detection result must never clobber one it cannot see.
    const current = useLibrary.getState().trackById(track.id)
    if (!current) return null
    if (current.grid) return current.grid
    const grid = makeGrid(firstBeatTime, bpm)
    writeTrack(id, current.id, { grid, bpm: grid.anchors[0].bpm })
    return grid
  } catch (err) {
    console.error('[deck] tempo detection failed', err)
    return null
  }
}

export const useDecks = create<DecksState>()(() => ({
  decks: perDeck(emptyDeck),
  crossfade: 0.5,

  async loadTrack(id, trackId) {
    const track = useLibrary.getState().trackById(trackId)
    if (!track) return

    // Claim the deck before the first await: a second load started while this
    // one is decoding must win, and every later step checks the token.
    const token = ++runtime[id].loadToken
    clearPreview(id)
    runtime[id].commandedSec = null
    patchDeck(id, {
      trackId,
      status: 'loading',
      playing: false,
      previewing: false,
      waveform: null,
      buffer: null,
      loop: null,
      clips: [],
      selectedClipId: null
    })

    let deck: Deck | null = null
    let audioLoaded = false
    try {
      const engine = AudioEngine.shared()
      await engine.init()
      // Loading is always driven by a user gesture, so this is the safe moment to
      // take the context out of its suspended state and apply the stored level.
      await engine.resume()
      engine.setMasterVolume(useSettings.getState().masterVolume)
      if (runtime[id].loadToken !== token) return

      deck = engine.deck(id)
      watchDeck(id, deck)
      // The channel keeps whatever it was set to, so a new track drops into an
      // EQ'd channel. Also lands knobs moved before the engine existed.
      applyEq(id, useDecks.getState().decks[id].eq)
      applyFader(id)

      // A deck that is still running must stop before its audio is replaced.
      if (deck.playing) deck.pause()
      deck.setLoop(false, 0, 0)

      const buffer = await decodeTrack(engine.ctx, track.path)
      if (runtime[id].loadToken !== token) return

      deck.load(buffer)
      audioLoaded = true
      deck.setPitchRate(1 + useDecks.getState().decks[id].pitchPercent / 100)
      // Load from track start.
      const start = 0
      deck.seekSeconds(start)
      runtime[id].commandedSec = start
      // One clip covering the whole file. The engine is told about it like any
      // other set of clips, so a never-cut deck and a cut one follow the same
      // path from here on.
      const clips = [wholeTrackClip(buffer.duration)]
      patchDeck(id, { buffer, clips, selectedClipId: null })
      deck.setRegions(toRegions(clips))

      const [waveform, grid] = await Promise.all([resolveWaveform(track, buffer), resolveGrid(id, track, buffer)])
      if (runtime[id].loadToken !== token) return

      patchDeck(id, { waveform, status: 'ready' })

      // Detecting a grid can have forked the track, so bookkeeping goes to
      // whatever the deck points at now, not the id it loaded.
      const written = useDecks.getState().decks[id].trackId ?? trackId
      const current = useLibrary.getState().trackById(written)
      const patch: Partial<Track> = {}
      if (waveform && grid && !current?.analyzed) patch.analyzed = true
      // A grid restored from disk may predate the bpm column being filled in.
      if (grid && current?.bpm == null) patch.bpm = grid.anchors[0].bpm
      if (Object.keys(patch).length > 0) writeTrack(id, written, patch)
    } catch (err) {
      console.error('[deck] load failed', track.path, err)
      // Every failure — decode, analysis, even the engine refusing to start —
      // has to land on a terminal status, or the deck is stuck behind a
      // spinner that no action can clear. A newer load owns the deck by now
      // and will land its own status, so only the current one cleans up.
      if (runtime[id].loadToken !== token) return
      if (audioLoaded) {
        // The audio did reach the worklet, so this is a playable deck that
        // simply has no waveform to draw.
        patchDeck(id, { waveform: null, status: 'ready' })
      } else {
        // Nothing to play here, and the worklet may still be holding the
        // previous track: left loaded it would keep sounding behind a deck
        // that shows as empty.
        deck?.unload()
        // Clear the track but leave the fader, quantize and zoom settings alone.
        patchDeck(id, {
          trackId: null,
          status: 'empty',
          playing: false,
      previewing: false,
          waveform: null,
          buffer: null,
          loop: null,
          clips: [],
          selectedClipId: null
        })
      }
    }
  },

  unloadDeck(id) {
    // Bump the token first: a decode still in flight must not drop its audio
    // onto a deck that has just been ejected.
    const rt = runtime[id]
    rt.loadToken++
    rt.commandedSec = null
    rt.taps.length = 0
    clearPreview(id)

    // `watching` is only set once the engine has handed this deck out, so it
    // doubles as "there is something to stop"; `deck()` throws before that.
    // Ejecting is the channel going away, not a track swap, so the knobs go
    // back to flat with it.
    const eq = flatChannel()
    if (rt.watching) {
      const deck = AudioEngine.shared().deck(id)
      if (deck.playing) deck.pause()
      deck.setLoop(false, 0, 0)
      applyEq(id, eq)
      deck.unload()
    }
    patchDeck(id, {
      trackId: null,
      status: 'empty',
      playing: false,
      previewing: false,
      waveform: null,
      buffer: null,
      loop: null,
      clips: [],
      selectedClipId: null,
      eq
    })
  },

  togglePlay(id) {
    const ctx = context(id)
    if (!ctx) return
    const rt = runtime[id]
    // Either branch leaves the playhead somewhere the store did not put it.
    rt.commandedSec = null
    const previewing = rt.cuePreview || rt.previewCueIndex !== null
    clearPreview(id)
    if (previewing) {
      // PLAY during a preview latches: the deck is already rolling from the cue
      // point and keeps going. `clearPreview` above dropped the return position
      // with the flag, so the release that follows leaves the playhead alone.
      if (!ctx.deck.playing) ctx.deck.play()
      patchDeck(id, { playing: true, previewing: false })
      return
    }
    ctx.deck.togglePlay()
    patchDeck(id, { playing: ctx.deck.playing, previewing: false })
  },

  cuePress(id) {
    const ctx = context(id)
    if (!ctx) return
    const cue = ctx.track.cuePoint ?? 0

    if (ctx.deck.playing) {
      // Back to cue.
      ctx.deck.pause()
      seekDeck(ctx, cue)
      clearPreview(id)
      patchDeck(id, { playing: false })
      return
    }

    if (atCuePoint(ctx, cue)) {
      // Sitting on the cue point: play for as long as the button is held.
      runtime[id].cuePreview = true
      runtime[id].previewReturnSec = cue
      playDeck(ctx)
      patchDeck(id, { playing: true, previewing: true })
      return
    }

    // Paused somewhere else: this is the new cue point.
    const time = snapped(ctx, ctx.position)
    writeTrack(id, ctx.track.id, { cuePoint: time })
    seekDeck(ctx, time)
  },

  cueRelease(id) {
    // Only CUE's own preview: the button coming up must not stop a pad's.
    if (!runtime[id].cuePreview) return
    useDecks.getState().endPreview(id)
  },

  endPreview(id) {
    const rt = runtime[id]
    if (!rt.cuePreview && rt.previewCueIndex === null) return
    // Read the return position before clearing, then stop and park on it. Both
    // preview branches always record one, so there is nothing to fall back to.
    const back = rt.previewReturnSec
    clearPreview(id)
    const ctx = context(id)
    // An ejected deck has already been stopped and cleared by `unloadDeck`.
    if (!ctx) return
    ctx.deck.pause()
    if (back != null) seekDeck(ctx, back)
    patchDeck(id, { playing: false })
  },

  seek(id, sec) {
    const ctx = context(id)
    if (!ctx) return
    seekDeck(ctx, sec)
  },

  beatJump(id, beats) {
    const ctx = context(id)
    if (!ctx || beats === 0) return
    const target = ctx.grid
      ? beatJumpTime(ctx.grid, ctx.position, beats, ctx.state.quantize)
      : ctx.position + beats * UNGRIDDED_BEAT_SEC
    seekDeck(ctx, target)
  },

  setPitch(id, percent) {
    const state = useDecks.getState().decks[id]
    const clamped = clamp(percent, -state.tempoRange, state.tempoRange)
    patchDeck(id, { pitchPercent: clamped })
    if (state.status === 'ready') AudioEngine.shared().deck(id).setPitchRate(1 + clamped / 100)
  },

  setTempoRange(id, range) {
    if (!(range > 0)) return
    const state = useDecks.getState().decks[id]
    // A narrower range pulls the fader in with it, as the hardware does.
    const pitchPercent = clamp(state.pitchPercent, -range, range)
    patchDeck(id, { tempoRange: range, pitchPercent })
    if (state.status === 'ready') AudioEngine.shared().deck(id).setPitchRate(1 + pitchPercent / 100)
  },

  toggleQuantize(id) {
    patchDeck(id, { quantize: !useDecks.getState().decks[id].quantize })
  },

  toggleKeyLock(id) {
    patchDeck(id, { keyLock: !useDecks.getState().decks[id].keyLock })
  },

  setBeatJumpBeats(id, beats) {
    if (!(beats > 0)) return
    patchDeck(id, { beatJumpBeats: clamp(beats, BEAT_JUMP_SIZES[0], BEAT_JUMP_SIZES[BEAT_JUMP_SIZES.length - 1]) })
  },

  setZoom(id, index) {
    patchDeck(id, { zoomIndex: Math.round(clamp(index, 0, WAVE_ZOOM_LEVELS.length - 1)) })
  },

  setHotCue(id, index) {
    const ctx = context(id)
    if (!ctx || index < 0 || index >= HOT_CUE_COUNT) return
    const cue: HotCue = {
      index,
      time: snapped(ctx, ctx.position),
      color: HOT_CUE_COLORS[index],
      type: 'cue'
    }
    writeHotCues(ctx, [...ctx.track.hotCues.filter((c) => c.index !== index), cue])
  },

  triggerHotCue(id, index) {
    const ctx = context(id)
    if (!ctx || index < 0 || index >= HOT_CUE_COUNT) return
    const cue = ctx.track.hotCues.find((c) => c.index === index)
    if (!cue) {
      // An empty pad sets a cue, the way the hardware pads do.
      useDecks.getState().setHotCue(id, index)
      return
    }

    if (cue.type === 'loop' && cue.loopBeats) {
      const end = beatsAfter(ctx.grid, cue.time, cue.loopBeats)
      ctx.deck.setLoop(true, cue.time, end)
      patchDeck(id, { loopBeats: cue.loopBeats, loop: { active: true, startSec: cue.time, endSec: end } })
    }

    const rt = runtime[id]
    // A preview makes sound, so `deck.playing` is true during one too.
    const previewing = rt.cuePreview || rt.previewCueIndex !== null

    if (ctx.deck.playing && !previewing) {
      // Playing: jump and keep rolling.
      seekDeck(ctx, cue.time)
      return
    }

    // Preview while this pad is held, then park on the cue point itself. The
    // press takes the preview over from any other pad or from CUE, so only
    // this pad's release ends it.
    rt.previewReturnSec = cue.time
    rt.previewCueIndex = index
    rt.cuePreview = false
    seekDeck(ctx, cue.time)
    playDeck(ctx)
    patchDeck(id, { playing: true, previewing: true })
  },

  releaseHotCue(id, index) {
    // Only the pad that owns the preview ends it; an overridden pad's release
    // does nothing.
    if (runtime[id].previewCueIndex !== index) return
    useDecks.getState().endPreview(id)
  },

  deleteHotCue(id, index) {
    const ctx = context(id)
    if (!ctx) return
    if (!ctx.track.hotCues.some((c) => c.index === index)) return
    writeHotCues(ctx, ctx.track.hotCues.filter((c) => c.index !== index))
  },

  addMemoryCue(id) {
    const ctx = context(id)
    if (!ctx) return
    const time = snapped(ctx, ctx.position)
    // Two memory cues on the same beat would be indistinguishable in the overview.
    if (ctx.track.memoryCues.some((m) => Math.abs(m.time - time) < 0.01)) return
    const memoryCues = [...ctx.track.memoryCues, { time }].sort((a, b) => a.time - b.time)
    writeTrack(id, ctx.track.id, { memoryCues })
  },

  deleteMemoryCueAt(id) {
    const ctx = context(id)
    if (!ctx) return
    const target = nearestPoint(pointsOfInterest(ctx.track), ctx.position, pointWindow(ctx), 'memory')
    // Nothing within a beat: delete nothing. Falling back to the nearest
    // locator anywhere would silently remove a marker off screen.
    if (!target) return
    // The point carries a time, not an index, so find the record it came from
    // and drop that one alone — filtering on time would take any other locator
    // sharing the instant with it.
    let victim = -1
    let closest = Infinity
    ctx.track.memoryCues.forEach((memory, i) => {
      const distance = Math.abs(memory.time - target.time)
      if (distance < closest) {
        closest = distance
        victim = i
      }
    })
    if (victim < 0) return
    writeTrack(id, ctx.track.id, { memoryCues: ctx.track.memoryCues.filter((_, i) => i !== victim) })
  },

  jumpToPoint(id, direction) {
    const ctx = context(id)
    if (!ctx) return
    // Read as next / previous, not "the furthest marker in that direction":
    // a jump to the furthest one would do nothing on a second press, which is
    // no use for walking a track. Change these two calls if the other reading
    // was meant.
    const points = pointsOfInterest(ctx.track)
    const target = direction > 0 ? nextPoint(points, ctx.position) : prevPoint(points, ctx.position)
    if (!target) return
    // `seekDeck` never starts or stops the deck, so a rolling deck carries on
    // from the marker and a stopped one parks on it.
    seekDeck(ctx, target.time)
  },

  nudgeGrid(id, beatFraction) {
    const ctx = context(id)
    if (!ctx || !ctx.grid) return
    writeGrid(ctx, nudgeGridBy(ctx.grid, beatFraction))
  },

  setDownbeatHere(id) {
    const ctx = context(id)
    if (!ctx || !ctx.grid) return
    writeGrid(ctx, setDownbeatAt(ctx.grid, ctx.position))
  },

  setGridBpm(id, bpm) {
    const ctx = context(id)
    if (!ctx || !(bpm > 0)) return
    // With no grid yet, the playhead becomes the first downbeat.
    const grid = ctx.grid ? setBpmAt(ctx.grid, ctx.position, bpm) : makeGrid(ctx.position, bpm)
    writeGrid(ctx, grid)
  },

  scaleGrid(id, factor) {
    const ctx = context(id)
    if (!ctx || !ctx.grid || !(factor > 0)) return
    writeGrid(ctx, scaleGridBpm(ctx.grid, factor))
  },

  tapTempo(id) {
    const ctx = context(id)
    if (!ctx) return
    const rt = runtime[id]
    const now = performance.now()
    // A long gap means the DJ stopped and started again, not a 20-second beat.
    if (rt.taps.length > 0 && now - rt.taps[rt.taps.length - 1] > TAP_TIMEOUT_MS) rt.taps.length = 0
    rt.taps.push(now)
    if (rt.taps.length > TAP_HISTORY) rt.taps.shift()
    if (rt.taps.length < 2) return

    const gaps: number[] = []
    for (let i = 1; i < rt.taps.length; i++) gaps.push(rt.taps[i] - rt.taps[i - 1])
    gaps.sort((a, b) => a - b)
    // Median, not mean: one fumbled tap should not drag the whole reading.
    const mid = gaps.length >> 1
    const interval = gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2
    const bpm = 60000 / interval
    if (!(bpm >= 40 && bpm <= 250)) return

    const grid = ctx.grid ? setBpmAt(ctx.grid, ctx.position, bpm) : makeGrid(ctx.position, bpm)
    writeGrid(ctx, grid)
  },

  toggleLoop(id) {
    const ctx = context(id)
    if (!ctx) return
    const current = ctx.state.loop

    if (current?.active) {
      ctx.deck.setLoop(false, 0, 0)
      // The bounds survive so the UI can offer a re-loop.
      patchDeck(id, { loop: { ...current, active: false } })
      return
    }

    const startSec = snapped(ctx, ctx.position)
    const endSec = beatsAfter(ctx.grid, startSec, ctx.state.loopBeats)
    ctx.deck.setLoop(true, startSec, endSec)
    patchDeck(id, { loop: { active: true, startSec, endSec } })
  },

  setLoopBeats(id, beats) {
    if (!(beats > 0)) return
    const loopBeats = clamp(beats, LOOP_SIZES[0], LOOP_SIZES[LOOP_SIZES.length - 1])
    const ctx = context(id)
    if (!ctx) {
      patchDeck(id, { loopBeats })
      return
    }
    const current = ctx.state.loop
    if (!current) {
      patchDeck(id, { loopBeats })
      return
    }
    // Halving or doubling holds the loop in point and moves the out point,
    // so the loop keeps its start the way the hardware's loop controls do.
    const endSec = beatsAfter(ctx.grid, current.startSec, loopBeats)
    if (current.active) ctx.deck.setLoop(true, current.startSec, endSec)
    patchDeck(id, { loopBeats, loop: { ...current, endSec } })
  },

  cutAtPlayhead(id) {
    const ctx = context(id)
    if (!ctx) return { ok: false, reason: 'Nothing loaded' }
    // Snap first, exactly as beat jump does: a cut half a beat off the grid is
    // no use to a DJ. The grid is in source time, which is also timeline time
    // as long as clips are only cut — a ripple delete moves later clips off
    // it, and re-gridding an edited deck is a problem for the PR that lets
    // clips move.
    // Snapping can land just outside the timeline when the grid's first beat
    // sits after zero, which would report the cut as falling in a gap rather
    // than as being too close to an edge. Keep it inside.
    const at = Math.max(0, Math.min(timelineDuration(ctx.state.clips), snapped(ctx, ctx.position)))
    const result = splitAt(ctx.state.clips, at)
    if (result.reason) return { ok: false, reason: CUT_REFUSALS[result.reason] }
    setClips(ctx, result.clips)
    return { ok: true }
  },

  selectClip(id, clipId) {
    // Refuse ids that are not on this deck, so the selection can never point
    // at a clip a delete or a reload has already taken away.
    if (clipId !== null && !useDecks.getState().decks[id].clips.some((c) => c.id === clipId)) return
    patchDeck(id, { selectedClipId: clipId })
  },

  deleteSelectedClip(id) {
    const ctx = context(id)
    if (!ctx) return
    const selected = ctx.state.selectedClipId
    if (selected == null) return
    if (!ctx.state.clips.some((c) => c.id === selected)) {
      patchDeck(id, { selectedClipId: null })
      return
    }
    // The hole comes back selected, so a second delete closes the row up
    // without having to find it again.
    const { clips, selectId } = deleteSegment(ctx.state.clips, selected)
    // Deleting the last piece leaves a deck still loaded, playing nothing. The
    // buffer, waveform and track stay put: a silent piece of the edit.
    setClips(ctx, clips, { selectedClipId: selectId })
  },

  reorderClipTo(id, clipId, index) {
    const ctx = context(id)
    if (!ctx) return
    if (!ctx.state.clips.some((c) => c.id === clipId)) return
    const clips = reorderClip(ctx.state.clips, clipId, index)
    // A move that changes nothing still arrives here on every pointer event,
    // and re-pushing the same regions would wake every subscriber for nothing.
    if (clips.every((clip, i) => clip.id === ctx.state.clips[i]?.id)) return
    setClips(ctx, clips, {})
  },

  moveClipTo(id, clipId, toStartSec) {
    const ctx = context(id)
    if (!ctx) return
    if (!Number.isFinite(toStartSec)) return
    const moving = ctx.state.clips.find((c) => c.id === clipId)
    if (!moving) return

    // A drop changes the order, it does not carve a hole where it lands. The
    // pieces are an arrangement: dragging one past its neighbour trades their
    // places and every piece keeps all of its audio. Nothing is trimmed and
    // nothing is overwritten, which is what a cut-up track is nearly always
    // for.
    const to = dropIndex(ctx.state.clips, clipId, Math.max(0, toStartSec))
    const clips = reorderClip(ctx.state.clips, clipId, to)
    // A drag that ends where it started still arrives here, and re-pushing the
    // same regions would wake every subscriber for nothing.
    if (clips.every((clip, i) => clip.id === ctx.state.clips[i]?.id)) return
    setClips(ctx, clips, {})
  },

  setFader(id, position) {
    const next = clamp(position, 0, 1)
    if (useDecks.getState().decks[id].fader === next) return
    patchDeck(id, { fader: next })
    applyFader(id)
  },

  setCrossfade(position) {
    const next = clamp(position, 0, 1)
    if (useDecks.getState().crossfade === next) return
    useDecks.setState({ crossfade: next })
    applyFader('A')
    applyFader('B')
  },

  setChannelKnob(id, knob, value) {
    if (!Number.isFinite(value)) return
    const eq = useDecks.getState().decks[id].eq
    const next = clamp(value, 0, 1)
    // Knobs are dragged, so this runs at pointer-move rate and the same value
    // arrives again and again. Dropping the repeats keeps a drag from waking
    // every subscriber for a move that changes nothing.
    if (eq[knob] === next) return
    const updated: ChannelEq = { ...eq }
    updated[knob] = next
    setEq(id, updated)
  },

  resetChannelKnob(id, knob) {
    useDecks.getState().setChannelKnob(id, knob, CENTRE)
  },

  resetChannelEq(id) {
    if (isFlat(useDecks.getState().decks[id].eq)) return
    setEq(id, flatChannel())
  }
}))

/**
 * A deck whose track leaves the library has nothing left to act on: every
 * action resolves the track first and then no-ops, so a playing deck would go
 * on playing with no way to stop it. Eject it instead.
 *
 * The dependency runs this way only — `useDecks` reads `useLibrary` throughout
 * — so `useLibrary` must never import this module back.
 */
useLibrary.subscribe((state, prev) => {
  if (state.tracks === prev.tracks && state.mirror === prev.mirror) return
  for (const id of DECK_IDS) {
    const trackId = useDecks.getState().decks[id].trackId
    if (trackId == null) continue
    // Both collections count. A deck holding a mirrored track is fine, and it
    // stays fine through the fork an edit creates: the mirrored record is
    // still there at the moment the local collection changes, and the deck
    // re-points to the fork immediately afterwards. Only a record that has
    // left both — a deleted local track, or one dropped by a sync — ejects.
    if (!state.tracks[trackId] && !state.mirror[trackId]) useDecks.getState().unloadDeck(id)
  }
})

/**
 * The EQ floor is one global preference, so changing it has to reach every
 * channel at once.
 *
 * Without this a channel already held at full cut would keep the old floor
 * until its knob moved again — switching to ISOLATOR would leave the one
 * channel it matters most on still leaking at -26 dB. Only the engine is
 * touched: the knob positions themselves do not change, so there is nothing
 * to write to the store.
 */
useSettings.subscribe((state, prev) => {
  if (state.eqMode === prev.eqMode) return
  for (const id of DECK_IDS) applyEq(id, useDecks.getState().decks[id].eq)
})
