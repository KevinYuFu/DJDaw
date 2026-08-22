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
- **EQ per track.** Trim, three-band EQ and a filter knob on all four decks,
  in both the mixer and the editing rows.
- **Cut / split.** `Ctrl+E` (or `Cmd+E`) splits at the playhead, plus a Cut
  button. Delete leaves a gap that plays silent; Shift+Delete closes it. Cuts
  snap to the beat grid when Quantize is on.
- **Moving clips.** Drag a piece along its row in the MACRO view. Drops snap
  to the grid when Quantize is on and go through `placeClip`, so a piece
  dropped on a neighbour trims or splits it the way a DAW does. Overlaps are
  gone with it: nothing can leave two clips claiming the same second.
- **Export.** Render an edit out as a file. WAV or MP3, one row or all four
  mixed, from the EXPORT button in the editing view. It runs the same worklet
  as playback inside an `OfflineAudioContext`, so the file is what was heard.
  MP3 is encoded in main and needs ffmpeg; without it the panel says so.

**Next**
- **Dragging between rows.** A piece moves along its own row today. Dropping
  it on another row is not built.
- **The grid drifts after a ripple delete.** The beat grid is in source time,
  which equals timeline time while a track is only cut. A ripple delete shifts
  later clips off it, so quantised cuts after one snap to the pre-ripple grid.
  Moving clips does the same. An edited row needs re-gridding.

**Later**
- **Back into rekordbox.** An export has to be imported into rekordbox by
  hand. Kevin wants it to land in his collection on its own. He has flagged it
  as a later problem, so it is written down rather than started. Worth knowing
  before it is: the XML we read is an export rekordbox writes, not a way in,
  so this is a different problem from the mirror and not an extension of it.
  **Ask Kevin first.**
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

## Master chain

Kevin's idea, not scheduled. A master processing chain after the crossfader,
with pluggable effects — a limiter first, since that is what stops the mix bus
clipping the output.

This matters more than it sounds. The channel crossover rotates phase between
bands, which grows peaks: a real loud master measured **+7.3 dB of peak growth
with every knob centred**, and +9.5 dB with the low boosted. Web Audio is float
internally so nothing clips inside the graph, but it clips at the output device
and again when an export is quantised. A master limiter is the standard answer
and every DJ application has one.

## Export

- **Exports can clip.** A loud master played through an interpolating engine
  peaks slightly above full scale — a real edit measured +1.0 dB — and the WAV
  encoder clamps, so those peaks flatten. Nothing here introduces it, it is a
  property of any interpolating player, but the export is where it becomes
  permanent. Wants either a warning with the measured peak, or a touch of
  headroom applied on render.
- **Getting an edit back into rekordbox.** Kevin's stated want: an export
  should land in his rekordbox collection without a manual import. rekordbox
  has no import API, so the likely routes are writing into a watched folder, or
  generating an XML that rekordbox can import. Not designed yet — **ask Kevin
  first**, since it touches his real library.

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

---

## Mixer

- **Isolator-style full kill.** The EQ cuts to -26 dB, like a DJM's EQ. Going
  to true silence needs a crossover rather than shelves, which is a different
  piece of DSP.
- Effects. There are none.

---

## The arrangement view and the decks

The arrangement view keeps its own tracks and shares nothing with the deck
views: switching tabs carries nothing across.

- **Record what is played on the decks, and lay it out as an arrangement.**
  Perform a mix on the decks, then open the arrangement view and find the moves
  already written down as clips to edit. This is the reason to connect the two,
  and it only goes one way — the decks stay the instrument, the arrangement
  stays the edit.

---

## Housekeeping

- **The SETUP modal has three wrong lines.** It warns that rekordbox's auto
  export may be Dropbox-only. Kevin's export goes to
  `~/Library/Pioneer/rekordbox/`, so those caveats should be deleted.
- **Windows and Linux.** `defaultRekordboxXmlPath()` only knows the macOS
  location and returns null elsewhere, rather than guessing.
