# DJDaw — architecture and module contracts

A rekordbox-style DJ workstation. Long-term goal: build edits and mashups
directly in the DJ environment (hot cues, beat grid, beat jump) instead of
bouncing to a DAW, then render the result out as a playable track. Offline
stem separation and stem-level editing come later; the audio engine is already
shaped for it.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Shell | Electron 43 (`electron-vite` 5) | Native filesystem, menus, packaging, and a Node side for future ffmpeg/Demucs sidecars. |
| UI | React 19 + TypeScript 5.9 | — |
| State | Zustand 5 | Small, no context/provider ceremony, easy to read outside React. |
| Audio | Web Audio `AudioWorklet` | A sample-position engine, like a CDJ. The same worklet runs inside `OfflineAudioContext`, so the future "render mashup to a track" export uses identical DSP to what you heard. |
| Rendering | 2D canvas | Waveforms are redrawn every frame; canvas is the only sane option. |

## Layout

```
src/
  shared/types.ts            Domain types (main + renderer)
  main/                      Electron main: dialogs, file IO, library store
  preload/                   contextBridge -> window.api
  renderer/
    public/worklets/         deck-processor.js (the DSP core)
    src/
      audio/                 AudioEngine, Deck, decode, deckProtocol
      analysis/              waveform + tempo detection (Web Workers)
      core/                  beatgrid maths, constants, formatting
      state/                 zustand stores
      components/            React UI
      hooks/                 keyboard, rAF helpers
      styles/                theme + component CSS
```

## Already written — do not rewrite, build against these

- `src/shared/types.ts` — `Track`, `BeatGrid`, `HotCue`, `WaveformData`, `LibraryFile`.
- `src/renderer/src/core/beatgrid.ts` — time <-> fractional beat index, snapping,
  `beatJumpTime`, `beatsInRange`, grid editing (`shiftGrid`, `setDownbeatAt`,
  `setBpmAt`, `scaleGridBpm`). **All position maths goes through this.**
- `src/renderer/src/core/constants.ts` — colours, sizes, beat-jump sizes.
- `src/renderer/src/core/format.ts` — time/BPM/pitch formatting, `clamp`.
- `src/renderer/src/audio/deckProtocol.ts` — worklet message contract.
- `src/renderer/public/worklets/deck-processor.js` — the deck DSP.

## Path aliases

`@shared/*` -> `src/shared/*`, `@renderer/*` -> `src/renderer/src/*`.
Use them in renderer code; main/preload use `@shared/*` only.

---

## Contract: preload bridge (`window.api`)

```ts
export interface DJDawApi {
  /** Native open dialog filtered to audio files. Returns absolute paths. */
  openAudioFiles(): Promise<string[]>
  /** Read tags + duration for paths, returning fully-formed Track records. */
  importPaths(paths: string[]): Promise<Track[]>
  /** Raw bytes for decodeAudioData. */
  readAudioFile(path: string): Promise<ArrayBuffer>
  /** ffmpeg fallback -> 32-bit float WAV bytes, for formats Chromium rejects. */
  transcodeToWav(path: string): Promise<ArrayBuffer>
  loadLibrary(): Promise<LibraryFile>
  saveLibrary(lib: LibraryFile): Promise<void>
  readWaveformCache(trackId: string): Promise<ArrayBuffer | null>
  writeWaveformCache(trackId: string, data: ArrayBuffer): Promise<void>
  revealInFinder(path: string): Promise<void>
  /** Menu commands from the app menu. Returns an unsubscribe fn. */
  onMenuCommand(cb: (command: string) => void): () => void
}
declare global { interface Window { api: DJDawApi } }
```

### Waveform cache file format (`<userData>/waveforms/<trackId>.djw`)

```
0..3    magic  'DJW1' (ASCII)
4..7    uint32 LE  header JSON byte length
8..     header JSON: { version, bucketSize, sampleRate, bucketCount, peak }
then    low[bucketCount], mid[bucketCount], high[bucketCount]   (Uint8)
```

Library JSON lives at `<userData>/library.json`.

---

## Contract: `audio/AudioEngine.ts`

```ts
export class AudioEngine {
  static shared(): AudioEngine
  readonly ctx: AudioContext
  readonly master: GainNode
  /** Creates the context, loads the worklet module. Idempotent. */
  init(): Promise<void>
  /** Resume after a user gesture. Call from the first click/keypress. */
  resume(): Promise<void>
  deck(id: DeckId): Deck
  setMasterVolume(linear: number): void
}
```

`init()` must `addModule(new URL(DECK_WORKLET_URL, window.location.href).href)`.
Create the context with `{ latencyHint: 'interactive' }`.

## Contract: `audio/Deck.ts`

```ts
export interface DeckSnapshot {
  frame: number; playing: boolean; scrubbing: boolean; rate: number; ctxTime: number
}

export class Deck {
  readonly id: DeckId
  readonly node: AudioWorkletNode
  readonly output: GainNode
  frames: number
  fileSampleRate: number
  durationSec: number

  /** Transfers *copies* of the channel data to the worklet. */
  load(buffer: AudioBuffer): void
  unload(): void

  play(): void
  pause(): void
  togglePlay(): void
  get playing(): boolean

  seekSeconds(sec: number): void
  /** Playhead in seconds, extrapolated from the last worklet report using
   *  `ctx.currentTime` so it is smooth at any frame rate. Cheap: call it in rAF. */
  positionSeconds(): number

  /** 1 = original tempo. Includes tempo-fader pitch. */
  setRate(rate: number): void
  setGain(linear: number): void
  setLoop(enabled: boolean, startSec: number, endSec: number): void

  beginScrub(): void
  scrubToSeconds(sec: number): void
  endScrub(): void

  onState(cb: (s: DeckSnapshot) => void): () => void
  onEnded(cb: () => void): () => void
}
```

**Critical:** `AudioBuffer.getChannelData()` returns a view onto the buffer's own
memory. Always `.slice()` before transferring to a worklet or worker, or the
`AudioBuffer` is detached and everything downstream breaks.

**Position extrapolation:** keep `lastSnapshot`; when playing,
`frame = snap.frame + (ctx.currentTime - snap.ctxTime) * snap.rate * fileSampleRate`,
clamped to `[0, frames]`.

## Contract: `audio/decode.ts`

```ts
/** Decode via the AudioContext, falling back to an ffmpeg transcode. */
export async function decodeTrack(ctx: BaseAudioContext, path: string): Promise<AudioBuffer>
```

## Contract: `analysis/waveform.ts`

```ts
export function analyzeWaveform(buffer: AudioBuffer): Promise<WaveformData>
export function encodeWaveform(w: WaveformData): ArrayBuffer   // .djw format above
export function decodeWaveform(data: ArrayBuffer): WaveformData | null
```

Implementation: run in `analysis/waveform.worker.ts`. Downmix to mono, split
into three bands with biquads — low < 200 Hz, mid 200–2000 Hz, high > 2000 Hz —
then take each band's peak absolute amplitude per `WAVEFORM_BUCKET` (128) frames
and scale to 0–255. Normalise all three bands by the same overall peak so the
relative balance between them is preserved.

## Contract: `analysis/bpm.ts`

```ts
export interface TempoResult { bpm: number; firstBeatTime: number; confidence: number }
export function detectTempo(buffer: AudioBuffer): Promise<TempoResult>
```

Implementation in `analysis/bpm.worker.ts`:
1. Spectral-flux onset envelope (FFT 1024, hop 256, Hann, half-wave rectified,
   sum of positive magnitude differences), then normalise.
2. Tempo: correlate the envelope against a comb/pulse train for every candidate
   BPM in 70–190 at 0.02 BPM resolution near the best coarse peak. Resolve
   octave errors by preferring 85–175.
3. Phase: for the winning BPM, test every offset within one beat period and take
   the one maximising summed onset strength.
4. Downbeat: Pioneer's own method, from patent JP6071274B2. Low-pass to 150 Hz,
   rectify, smooth at 5 Hz and peak-pick to find kick hits, dropping peaks below
   the mean. Only two kinds of hit vote: the first kick in the track (double
   weight) and the first kick after each break of 8+ beats. A hit only votes if
   the next one follows at 0.5, 1 or 2 beats within 10%. The winning accumulator
   sets the bar line. With no qualifying votes it falls back to the older
   low-band-energy heuristic. Return `firstBeatTime` as the first downbeat at or
   after t=0.

Return `bpm` rounded to 2 decimals. Do not fabricate confidence: derive it from
the winning correlation peak relative to the runner-up.

## Contract: state (`state/`)

Three stores. **The playhead is deliberately not in React state** — pushing a
60 Hz position through the store would re-render the whole app every frame.
Slow-changing values live in the store; anything that moves with the playhead
reads `Deck.positionSeconds()` inside its own `requestAnimationFrame` loop and
writes to canvas or to a DOM node directly.

```ts
// state/useLibrary.ts
interface LibraryState {
  tracks: Record<string, Track>
  order: string[]                     // display order
  search: string
  sortBy: keyof Track; sortDir: 'asc' | 'desc'
  selectedId: string | null
  loadFromDisk(): Promise<void>
  importFiles(): Promise<void>        // dialog -> importPaths -> add -> analyse
  addTracks(tracks: Track[]): void
  updateTrack(id: string, patch: Partial<Track>): void
  removeTrack(id: string): void
  setSearch(q: string): void
  setSort(by: keyof Track): void
  select(id: string | null): void
  visibleTracks(): Track[]            // search + sort applied
}

// state/useDecks.ts
interface DeckState {
  trackId: string | null
  status: 'empty' | 'loading' | 'ready'
  playing: boolean
  /** Tempo fader position in percent, -range..+range. */
  pitchPercent: number
  tempoRange: number                  // 6 | 10 | 16 | 100
  keyLock: boolean                    // UI only for now
  quantize: boolean                   // default true
  beatJumpBeats: number               // default DEFAULT_BEAT_JUMP (16)
  loopBeats: number
  loop: { active: boolean; startSec: number; endSec: number } | null
  zoomIndex: number
  /** Waveform data, kept out of the library store because it is large. */
  waveform: WaveformData | null
  /** The AudioBuffer stays here so analysis and export can reach it. */
  buffer: AudioBuffer | null
}

interface DecksState {
  decks: Record<DeckId, DeckState>
  loadTrack(deck: DeckId, trackId: string): Promise<void>
  // transport
  togglePlay(deck: DeckId): void
  cuePress(deck: DeckId): void        // CDJ cue semantics, see below
  cueRelease(deck: DeckId): void
  seek(deck: DeckId, sec: number): void
  beatJump(deck: DeckId, beats: number): void
  setPitch(deck: DeckId, percent: number): void
  setTempoRange(deck: DeckId, range: number): void
  toggleQuantize(deck: DeckId): void
  setBeatJumpBeats(deck: DeckId, beats: number): void
  setZoom(deck: DeckId, index: number): void
  // cues
  setHotCue(deck: DeckId, index: number): void       // at the current position
  triggerHotCue(deck: DeckId, index: number): void
  deleteHotCue(deck: DeckId, index: number): void
  addMemoryCue(deck: DeckId): void
  // grid
  nudgeGrid(deck: DeckId, beatFraction: number): void
  setDownbeatHere(deck: DeckId): void
  setGridBpm(deck: DeckId, bpm: number): void
  scaleGrid(deck: DeckId, factor: number): void
  tapTempo(deck: DeckId): void
  // loop
  toggleLoop(deck: DeckId): void
  setLoopBeats(deck: DeckId, beats: number): void
}
```

### rekordbox behaviours to reproduce exactly

**Beat jump** — walks the grid by N beats via `beatJumpTime`, so it stays
phase-locked. With Quantize on the position snaps to the nearest beat first,
which is why repeated jumps land dead on the grid. `Q` = back 16, `W` = forward 16.

**Hot cues** — 8 pads, A–H. Empty pad + press = set a cue at the current
position (snapped to the grid when Quantize is on). Filled pad + press = jump
there; if the deck was playing it keeps playing, if it was paused it plays for
as long as the pad is held and returns to where it was on release. Shift+press
deletes.

**CUE button** — CDJ semantics:
- playing -> jump back to the cue point and pause ("back to cue")
- paused, playhead already at the cue point -> preview: play while held, return
  to the cue point on release
- paused elsewhere -> set the cue point here (grid-snapped when Quantize is on)
- pressing PLAY during a preview keeps playing from the cue point

**Quantize** — on by default, 1 beat. Applies to hot cue set/trigger, loops and
beat jump.

**Tempo fader** — `rate = 1 + pitchPercent / 100`; displayed BPM is
`grid bpm * rate`.

### Keyboard map

Deck A unshifted, deck B with the right-hand cluster. `Shift` modifies.

| Key | Action |
| --- | --- |
| `Space` | Play / pause (focused deck) |
| `Q` | Beat jump back 16 |
| `W` | Beat jump forward 16 |
| `Shift+Q` / `Shift+W` | Halve / double the beat-jump size |
| `1`–`8` | Hot cue A–H (set if empty, trigger if set) |
| `Shift+1`–`8` | Delete hot cue A–H |
| `C` | CUE |
| `L` | Toggle loop |
| `[` / `]` | Loop length halve / double |
| `,` / `.` | Nudge the grid back / forward 1/32 beat |
| `G` | Set downbeat at the playhead |
| `T` | Tap tempo |
| `Y` | Toggle quantize |
| `-` / `=` | Waveform zoom out / in |
| `←` / `→` | Nudge the playhead by one beat |
| `Tab` | Switch the focused deck |

Text inputs must swallow these — check `event.target` before handling.

## UI: matching rekordbox

Dark, dense, flat. Top-to-bottom: toolbar, two decks side by side sharing a
central mixer strip, then the browser. Deck internals, top to bottom: track
header (artwork, title, artist, key, BPM, elapsed/remaining), overview waveform
(whole track, thin), detailed scrolling waveform (playhead fixed in the centre,
grid ticks along the bottom, hot cue flags), then a row with the jog wheel,
transport, tempo fader, and the pad/beat-jump/loop controls.

Waveform colours are the classic Pioneer three-band mapping: blue lows, orange
mids, white highs, drawn back to front and mirrored about the centre line.

All colours come from CSS variables in `styles/theme.css`. Never hard-code a
hex in a component; canvas code takes its colours from `core/constants.ts`.

## rekordbox import

`src/shared/rekordboxXml.ts` scans a rekordbox XML export;
`src/shared/rekordboxImport.ts` converts it to DJDaw tracks. Both are
dependency-free and DOM-free so they run in the main process — a large
collection is parsed there and never crosses IPC as a string — and under plain
Node in `test/rekordbox.test.mjs`.

Two model differences carry the real risk, and both are covered by tests:

- **Grid phase.** A rekordbox `TEMPO` marker can sit on any beat of the bar and
  says which via `Battito`; DJDaw anchors beat 0 on a downbeat. The first marker
  is walked back to its bar line, stepping forward whole bars if that would land
  before the file. Beat positions and bar lines are identical either way.
- **Cue kind.** `POSITION_MARK` uses `Num` to mean hot cue (0-7) or memory cue
  (-1), and `Type` 4 for a loop. The earliest memory cue is promoted to the
  deck's CUE point, since that is where a CDJ loads a track.

`mergeImported` in `rekordboxImport.ts` is the single merge policy for every
import route: metadata always refreshes, grids and cues only fill in where DJDaw
has none.

## The two collections

DJDaw shows two collections side by side, and the split is the whole design:

- **rekordbox** — a read-only mirror of the last XML export. Never persisted;
  rebuilt from the XML on every sync, so it is always exactly what rekordbox
  said, deletions included.
- **Collection** — local records. This is what `library.json` holds.

Editing anything on a mirrored track forks it into the local collection
(`src/shared/collection.ts`), and the edit lands on the fork. The two are
independent from then on: later rekordbox changes never reach the fork, and a
re-export never overwrites your work. The same file therefore appears twice
once forked, which is accepted deliberately.

**Ids.** A local id is the audio key (sha1 of the resolved path); a mirrored id
is that key prefixed `rb-`. Both carry `audioKey`, and the **waveform cache is
keyed on `audioKey`, not on the id**, so a fork inherits the analysis instead of
re-running it on the identical file.

**Every write goes through `resolveWrite(id, local, mirror)`**, which returns the
id to write to plus a fork to insert when one is needed. Callers must adopt the
returned id — a deck holding a mirrored id has to re-point at the fork, or its
next edit forks again and the first edit is stranded.

**Sync is only as fresh as the last export.** main watches the XML file and
re-syncs whenever it changes. rekordbox 7 can write that file itself: it has a
built-in Auto Export that fires when rekordbox quits
(`CollectionAutoExportEnable` / `CollectionAutoExportXmlFile` in
`rekordbox3.settings`). With that on, the user never exports by hand, but the
file still only appears when rekordbox closes — so the mirror is current as of
the last time rekordbox quit, not live. The SETUP modal in the toolbar walks
through enabling it.

### IPC additions

```ts
/** Pick and remember an XML export, then sync immediately. */
chooseRekordboxXml(): Promise<RekordboxSyncResult>
/** Re-read the remembered XML now. */
syncRekordbox(): Promise<RekordboxSyncResult>
/** Forget the remembered path and clear the mirror. */
clearRekordboxXml(): Promise<void>
/** Pushed whenever the watched file changes. Returns an unsubscribe fn. */
onRekordboxSync(cb: (result: RekordboxSyncResult) => void): () => void
```

The remembered path lives in `LibraryFile.rekordboxXmlPath`.

## Side project: better downbeat detection

Parked, not scheduled. The current detector follows Pioneer's own method
(patent JP6071274B2): low-pass to 150 Hz to isolate the kick, then vote on the
bar phase using the first kick in the track and the first kick after each break.
That is what rekordbox does, so it should match rekordbox's behaviour including
its known weakness on kick-free intros.

If we want to beat rekordbox rather than match it:

**Beat This!** (CPJKU, ISMIR 2024) is the strongest published beat/downbeat
tracker with a usable licence — MIT on both the code and the weights, which is
rare here. Downbeat F1 95.3 on Ballroom (the closest published proxy for 4/4
dance music), 78.3 on GTZAN.

- madmom scores worse *and* its model files are CC BY-NC-SA, so it cannot ship
  in anything commercial. Not an option.
- BeatNet depends on madmom and is built for realtime, which this app does not
  need.
- Two ways to run Beat This!: a Python sidecar (the reference implementation,
  and we will want Python anyway for Demucs), or the `beat_this_cpp` ONNX port
  through `onnxruntime-node`, which avoids Python entirely but means
  reimplementing the mel-spectrogram frontend in TypeScript — a real risk of
  silent accuracy drift.

## Not built yet (deliberately)

Channel EQ, filter and trim are real. Each deck runs
trim -> three-way Linkwitz-Riley crossover -> a gain per band -> summed ->
filter -> fader. It is a crossover-and-sum rather than shelving filters,
because only a crossover can take a band to silence — which is what an isolator
is. Ableton's EQ Three works the same way.

Crossovers at 250 Hz and 2.5 kHz. Two modes, as rekordbox exposes them:
EQ cuts to -26 dB like a DJM channel EQ, ISO cuts to silence. Both boost +6 dB.
The mapping lives in `src/shared/eq.ts`; the graph is built by
`createChannelStrip` in `audio/Deck.ts`, which takes a `BaseAudioContext` so an
offline export builds the identical strip rather than a second copy that can
drift.

Two traps worth knowing, both found by measuring rather than reading:

- **Web Audio reads `Q` on a lowpass/highpass in decibels, not as a Q factor.**
  Passing 0.7071 asks for Q 1.085. Three resonant slopes summed measured
  +7.4 dB at each crossover with every knob centred. `Deck.ts` converts.
- A Butterworth split leaves +3 dB on each crossover even when flat, which is a
  measured artefact of EQ Three. Linkwitz-Riley sums flat; measured worst
  deviation across 30 Hz - 18 kHz is -0.12 dB.

Every parameter is ramped rather than stepped, because a stepped gain is an
audible click and a stepped filter frequency zippers. Key detection, key lock / master tempo (needs a time-stretcher),
stem separation, the edit/arrangement timeline and track export are all future
work. `Track.key` and `DeckState.keyLock` exist so the UI does not have to
change shape when they land.
