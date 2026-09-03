# Third-party components

What DJDaw ships that someone else wrote, and under what terms.

This is a record of provenance, not legal advice. Where a chain has a weak
link it is named as one rather than glossed over.

## Runtime dependencies

| package | version | licence |
| --- | --- | --- |
| `@electron-toolkit/utils` | ^4.0.0 | MIT |
| `@huggingface/transformers` | ^3.8.1 | Apache-2.0 |
| `@waveform-playlist/core` | ^12.6.1 | MIT |
| `@waveform-playlist/engine` | ^13.6.0 | MIT |
| `demucs-web` | ^1.0.2 | MIT |
| `music-metadata` | ^11.2.1 | MIT |
| `onnxruntime-web` | ^1.29.0 | MIT |
| `signalsmith-stretch` | ^1.3.2 | MIT |
| `zustand` | ^5.0.15 | MIT |

Electron and its toolchain are MIT. `ffmpeg` is called as an external program
and is not distributed with the app; on a machine without it the features that
need it say so.

## Model weights

Weights are not in this repository. `npm run fetch:model` pulls them before a
build.

### Stem separation — `htdemucs_embedded.onnx`, 172 MB

- **Weights**: Hybrid Transformer Demucs, from
  [facebookresearch/demucs](https://github.com/facebookresearch/demucs) — **MIT**
- **Export and the code that drives it**:
  [timcsy/demucs-web](https://github.com/timcsy/demucs-web) — **MIT**
- **Where the file is fetched from**:
  [timcsy/demucs-web-onnx](https://huggingface.co/timcsy/demucs-web-onnx) —
  **no licence stated**

**The weak link.** The repository holding the converted file states no terms.
The weights it derives from are MIT and the code that converted them is MIT,
and a mirror that omits a licence does not remove the one the work already
carries. But the file itself carries no statement, and no published ONNX export
of these weights does.

To close it properly the export has to be produced from the MIT release
directly, which needs Python and PyTorch at build time. That has not been done.

### Transcription — `whisper-base`, 293 MB

- **Weights**: Whisper, from [OpenAI](https://github.com/openai/whisper) —
  **MIT** for the code, **Apache-2.0** for the released weights
- **Export**: [Xenova/whisper-base](https://huggingface.co/Xenova/whisper-base)
  — **Apache-2.0**, stated

Chosen over other exports of the same weights precisely because it states its
terms. Several alternatives transcribe identically and say nothing.

## Data

### Word list

The list a censor listens for is the
[List of Dirty, Naughty, Obscene and Otherwise Bad Words](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words),
**CC BY 4.0**. Attribution is a condition of that licence and is carried in
`src/shared/badWords.ts` as well as here.

## Apache-2.0 notices

`@huggingface/transformers` and the Whisper weights are Apache-2.0, which asks
that notices travel with the work. Both are named above with their source.
