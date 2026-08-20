# Roadmap

Things we want but have not built. Kept so nothing gets lost between sessions.

Anything marked **ask Kevin first** means the design is his call and must not be
invented — see CLAUDE.md.

---

## Editing view

The new view. Four tracks stacked vertically. Each one still navigates like a
rekordbox deck: `Q` / `W` beat jump, number keys for hot cues, `Tab` to move
between tracks.

**Done**
- The view itself, four stacked tracks, focus and `Tab` switching
- Per-track rekordbox navigation

**Next**
- **Cut / split.** `Ctrl+E` splits the track at the playhead, the way Ableton
  does. Plus a Cut button. Pieces can then be moved or deleted.
- **EQ per track.** Real DSP. Today the EQ knobs in the mixer are drawn but
  inert, so this is the first real filter work in the app.

**Later**
- **Automation.** Draw in fader, EQ and effect moves over time.
  **Ask Kevin first** — he has a specific system in mind for making this easy
  to draw. Do not design one.
- **Sample browser.** Browse a folder and drag samples straight into a track.

---

## Library

- **Folder drag and drop.** Dropping a folder currently says folders are not
  scanned. Should walk it and import the audio inside.
- **Playlists.** Already parsed out of the rekordbox XML and counted, but not
  shown. The sidebar node is still a stub.

---

## Analysis

- **Better downbeat detection.** The detector now follows Pioneer's own method
  (patent JP6071274B2), so it should behave about like rekordbox — including
  rekordbox's weakness on kick-free intros.

  To beat rekordbox rather than match it: **Beat This!** (CPJKU, ISMIR 2024).
  MIT licence on both code and weights, which is rare in this field. Downbeat
  F1 95.3 on Ballroom, the closest published proxy for 4/4 dance music.
  Two ways to run it — a Python sidecar (the reference implementation, and we
  want Python anyway for stem separation), or the `beat_this_cpp` ONNX port
  through `onnxruntime-node`, which avoids Python but means rewriting the
  mel-spectrogram frontend in TypeScript.

  Parked on 2026-08-18: Kevin judged it too much work for now.

- **Half-time on backbeat material.** Tracks above about 150 BPM with a strong
  backbeat can read at half speed. `x2` fixes it by hand.
- **One bad reading to chase.** Virtual Riot — Bossfight Afterparty detected at
  105 BPM, which is not a clean octave of anything sensible. Suspect the comb
  filter locking onto a dotted subdivision.
- **Key detection.** `Track.key` exists and is filled from rekordbox, but
  nothing detects it locally.

---

## Playback

- **Master tempo / key lock.** Needs a time-stretcher. The button is drawn and
  disabled.
- **Stem separation.** Offline, quality over speed. Demucs via a Python
  sidecar. The deck engine already carries a stem layer array with per-layer
  gain, so playback needs no re-architecting — one layer today is the full mix.
- **Export.** Render an edit out as a playable track. The deck worklet already
  runs inside `OfflineAudioContext`, so the render will use identical DSP to
  what was heard.

---

## Mixer

- EQ, filter and trim DSP. Drawn but inert today.
- Only the channel faders and crossfader are actually wired.

---

## Housekeeping

- **The SETUP modal has three wrong lines.** It warns that rekordbox's auto
  export may be Dropbox-only. Kevin's export goes to
  `~/Library/Pioneer/rekordbox/`, so those caveats should be deleted.
- **Windows and Linux.** `defaultRekordboxXmlPath()` only knows the macOS
  location and returns null elsewhere, rather than guessing.
