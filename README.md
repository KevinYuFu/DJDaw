# DJDaw

A rekordbox-style DJ workstation, built so that edits and mashups can be made
where you already know the track — on a deck, with hot cues and a beat grid —
instead of rebuilding the arrangement in a DAW.

This first cut is the deck itself: import, analyse, grid, cue, scrub, play,
beat jump. Everything past that (stems, arrangement, export) is built on top of
the same engine, which is why the engine is a sample-position playback core
rather than a pile of `AudioBufferSourceNode`s.

## Running it

Needs **Node 22.12 or newer**. On older Node, Electron's postinstall fails
silently — `npm install` looks like it worked, then `npm run dev` dies with
`Error: Electron uninstall`, because the install script `require()`s an ESM
module and only 22.12+ allows that. If you hit it:

```bash
node --experimental-require-module node_modules/electron/install.js
```

```bash
npm install
npm run dev          # Electron + Vite, hot reload
npm test             # beat grid + formatting unit tests
npm run typecheck
npm run build:mac    # packaged .dmg
```

`ffmpeg` on your `PATH` is optional — it is only used to transcode formats
Chromium refuses to decode (some AIFF and WMA files).

## What works

| | |
| --- | --- |
| Import | Native file dialog, tags and artwork via `music-metadata`, persistent collection |
| rekordbox | Import a whole collection from a rekordbox XML export, with beat grids, hot cues and locators |
| Analysis | Three-band waveform + tempo and downbeat detection, cached to disk |
| Beat grid | Editable: nudge, set downbeat, set BPM, tap tempo, ×2 / ÷2 |
| Transport | Play/pause, CDJ cue semantics, tempo fader, scrub by waveform or jog wheel |
| Hot cues | 8 pads A–H, set / jump / hold-to-preview / delete, saved with the track |
| Locators | Drop a marker while listening, named or not, then jump between markers |
| Beat jump | Grid-walking, quantised, `Q` back 16 and `W` forward 16 |
| Waveforms | Full-track overview and a centre-locked scrolling detail view |
| Editing | Lanes of clips on one grid, with a second stacked-track view kept as Edit Legacy |

## Importing your rekordbox collection

`REKORDBOX XML` in the browser, or File > Import rekordbox Collection
(`Cmd+Shift+O`). It reads a collection exported from rekordbox and brings over
the analysis you already paid for: beat grids (including tracks with tempo
changes), hot cues A-H with their colours and names, memory cues (locators
here), the CUE point, key, rating, colour tag and genre. A track that arrives with a rekordbox
grid is marked analysed, so the deck trusts it instead of re-detecting; only the
waveform is generated locally on first load.

To produce the file, in rekordbox: **File > Export Collection in xml format**.

Two things worth knowing:

- **rekordbox 6/7's live database (`master.db`) is not read.** It is
  SQLCipher-encrypted, and reading it would mean going around that. The XML
  export is the format rekordbox publishes for interchange, it is a copy rather
  than the database rekordbox is actively writing, and it is stable across
  versions. Re-export whenever you want to re-sync.
- **Re-importing never destroys your work here.** Metadata is refreshed from
  rekordbox every time, but a grid or a set of cues you edited in DJDaw is kept;
  imported grids and cues only fill in where DJDaw has none.

Playlists are parsed and counted but not shown yet — the collection is what the
browser displays today.

## Known limits of the analyser

Tempo detection is solid on four-on-the-floor material — it recovers the exact
BPM across 70–190 on click tracks. Two things it still gets wrong, both
measured:

- Backbeat-heavy material above about 150 BPM can read as half time (a 174 BPM
  track detected as 87). The correlation prefers the half tempo there. Fix it
  with the x2 button.
- The downbeat can land a beat off, so bar lines are wrong while the beats
  themselves are correct. `G` (set downbeat at the playhead) fixes it. Beat jump
  is unaffected, since it walks beats rather than bars.

Both are one keypress to correct, and the corrected grid is saved with the
track. Analysis results never overwrite a grid you edited.

## Not built yet

Key detection, master tempo (key lock), stem separation and track export are
the next milestones. The EQ cuts to -26 dB like a DJM's EQ rather than to
silence; isolator-style full kill needs a crossover and is not built.

## Keyboard

| Key | |
| --- | --- |
| `Space` | Play / pause |
| `Q` / `W` | Beat jump back / forward 16 beats |
| `Shift+Q` / `Shift+W` | Halve / double the beat-jump size (decks only) |
| `1`–`8` | Hot cue A–H (set if empty, jump if set) |
| `Shift+1`–`8` | Delete hot cue |
| `A` | Load the selected library track |
| `Z` | Cue |
| `X` | Drop a locator at the playhead |
| `C` | Delete the locator at the playhead |
| `D` / `F` | Jump to the next / previous point of interest |
| `L`, `[`, `]` | Loop toggle, halve, double |
| `,` / `.` | Nudge the grid |
| `G` | Set downbeat at the playhead |
| `T` | Tap tempo |
| `Y` | Quantize |
| `-` / `=` | Waveform zoom |
| `←` / `→` | Nudge the playhead one beat |
| `Tab` | Switch focused deck |

A **point of interest** is a locator, a hot cue or the CUE point. `D` and `F`
walk all of them in time order.

**Locators** are markers you drop while a track plays. Drop one with `X`, jump
between them with `D` and `F`. They are drawn
on both waveforms, with their name where there is room. They are the same thing
rekordbox calls a memory cue, so an import brings yours over.

## Design

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module contracts, the
worklet protocol and the rekordbox behaviours the app reproduces.

The short version: the deck is an `AudioWorklet` that owns a fractional sample
playhead. Hot cues, beat jump, loops and scrubbing are all "move the playhead",
spliced with a short equal-power crossfade so they never click. Beat positions
go through one grid module that converts between seconds and a fractional beat
index, so a beat jump walks the grid and stays phase-locked. The same worklet
runs inside an `OfflineAudioContext`, which is how the future export will render
a mashup with exactly the DSP you heard.

## Third-party components

What the app ships that someone else wrote, and under what terms, is recorded
in [THIRD-PARTY.md](THIRD-PARTY.md).
