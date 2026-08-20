/**
 * Deck engine playhead behaviour, driven under Node with stubbed AudioWorklet
 * globals so positions can be asserted frame-exactly.
 *
 * These guard one specific hazard: the deck deliberately keeps rendering audio
 * for ~6 ms after the transport stops, so the stop does not click. Every one of
 * these cases is somewhere that fade could be left advancing the playhead —
 * which showed up as hot cues and CUE landing several milliseconds late, and as
 * jog nudges creeping forward.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { eq, ok } = globalThis.__t

const SR = 48000
let Processor = null
globalThis.sampleRate = SR
globalThis.currentTime = 0
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { postMessage() {}, onmessage: null }
  }
}
globalThis.registerProcessor = (_name, cls) => {
  Processor = cls
}

const here = dirname(fileURLToPath(import.meta.url))
const worklet = join(here, '..', 'src', 'renderer', 'public', 'worklets', 'deck-processor.js')
new Function(readFileSync(worklet, 'utf8'))()

const FRAMES = SR * 60

function deck() {
  const p = new Processor()
  const ch = new Float32Array(FRAMES)
  for (let i = 0; i < FRAMES; i++) ch[i] = Math.sin(i * 0.01) * 0.5
  p.port.onmessage({ data: { type: 'load', stems: [{ id: 'mix', channels: [ch, ch] }], frames: FRAMES, sampleRate: SR } })
  return p
}
const cmd = (p, m) => p.port.onmessage({ data: m })
const scratch = [[new Float32Array(128), new Float32Array(128)]]
const render = (p, quanta) => {
  for (let i = 0; i < quanta; i++) p.process([], scratch)
}
/** Render well past the declick fade, so the playhead has settled. */
const settle = (p) => render(p, 40)

// Pause and seek arrive in the same tick for back-to-cue, CUE release and
// hot cue preview release. The seek target has to win.
{
  const p = deck()
  cmd(p, { type: 'play' })
  render(p, 200)
  cmd(p, { type: 'pause' })
  cmd(p, { type: 'seek', frame: 48000 })
  settle(p)
  eq('pause then seek lands exactly on the target', p.pos, 48000, 0.51)
}
{
  const p = deck()
  cmd(p, { type: 'play' })
  render(p, 200)
  cmd(p, { type: 'seek', frame: 48000 })
  cmd(p, { type: 'pause' })
  settle(p)
  eq('seek then pause lands exactly on the target', p.pos, 48000, 0.51)
}
{
  const p = deck()
  cmd(p, { type: 'play' })
  render(p, 200)
  const stoppedAt = p.pos
  cmd(p, { type: 'pause' })
  settle(p)
  eq('a plain pause parks where the transport stopped', p.pos, stoppedAt, 0.51)
}

// Auditioning a hot cue from a paused deck must return to the same frame every
// time; any per-press error accumulates directly under the user's hand.
{
  const p = deck()
  cmd(p, { type: 'seek', frame: 100000 })
  settle(p)
  const home = p.pos
  for (let i = 0; i < 20; i++) {
    cmd(p, { type: 'seek', frame: 48000 })
    cmd(p, { type: 'play' })
    render(p, 30)
    cmd(p, { type: 'pause' })
    cmd(p, { type: 'seek', frame: home })
    settle(p)
  }
  eq('20 hot cue preview cycles accumulate no drift', p.pos, home, 0.51)
}

// Letting go of the platter parks it where the hand left it, in both directions.
for (const [name, target] of [['forward', 205000], ['backward', 195000]]) {
  const p = deck()
  cmd(p, { type: 'seek', frame: 200000 })
  settle(p)
  cmd(p, { type: 'scrub', active: true })
  cmd(p, { type: 'scrubTarget', frame: target })
  render(p, 20)
  const released = p.pos
  cmd(p, { type: 'scrub', active: false })
  settle(p)
  eq(`a ${name} jog nudge parks where it was released`, p.pos, released, 0.51)
}

// A seek far outside an active loop must resolve in one step. Unwinding one
// loop length per sample renders a long burst of discontinuous audio.
{
  const p = deck()
  cmd(p, { type: 'loop', enabled: true, startFrame: 48000, endFrame: 49208 })
  cmd(p, { type: 'play' })
  cmd(p, { type: 'seek', frame: 12000000 })
  p.process([], scratch)
  ok('a seek past an active loop re-enters it within one render quantum', p.pos >= 48000 && p.pos < 49208)
  let peak = 0
  for (let q = 0; q < 8; q++) {
    p.process([], scratch)
    for (const v of scratch[0][0]) peak = Math.max(peak, Math.abs(v))
  }
  ok('audio after a loop wrap stays in range', peak <= 1.01)
}

{
  const p = deck()
  cmd(p, { type: 'seek', frame: 50000 })
  settle(p)
  const start = p.pos
  for (let i = 0; i < 10; i++) {
    cmd(p, { type: 'play' })
    render(p, 10)
    cmd(p, { type: 'pause' })
    settle(p)
  }
  ok('playback still advances across play/pause cycles', p.pos > start)
}

// ---------------------------------------------------------------------------
// Regions: the playhead is a timeline position, not a position in the file.
// ---------------------------------------------------------------------------

/** What the source signal is at a given file frame, for checking the mapping. */
const source = (frame) => Math.sin(frame * 0.01) * 0.5
/** Second 0-1 of the file, then a one-second hole, then second 10-11. */
const GAPPED = [
  { startFrame: 0, endFrame: SR, sourceOffsetFrame: 0 },
  { startFrame: 2 * SR, endFrame: 3 * SR, sourceOffsetFrame: 10 * SR }
]

/** Render `quanta`, returning the left channel as one contiguous array. */
const capture = (p, quanta) => {
  const out = new Float32Array(quanta * 128)
  for (let q = 0; q < quanta; q++) {
    p.process([], scratch)
    out.set(scratch[0][0], q * 128)
  }
  return out
}

// A deleted piece is a hole, not a stop: it plays as silence and the playhead
// runs straight through it.
{
  const p = deck()
  cmd(p, { type: 'regions', regions: GAPPED })
  cmd(p, { type: 'play' })
  const peaks = []
  for (let q = 0; q < 1100; q++) {
    p.process([], scratch)
    let peak = 0
    for (const v of scratch[0][0]) peak = Math.max(peak, Math.abs(v))
    peaks.push({ pos: p.pos, peak })
  }
  const at = (sec) => peaks.find((s) => s.pos >= sec * SR).peak
  ok('the first region plays', at(0.5) > 0.3)
  ok('the gap is silent', at(1.5) === 0)
  ok('the second region plays', at(2.5) > 0.3)
  eq('the playhead crosses the gap without stopping', p.pos, 1100 * 128, 0.51)
}

// A region boundary is a source discontinuity and clicks unless it is spliced.
{
  const p = deck()
  cmd(p, {
    type: 'regions',
    regions: [
      { startFrame: 0, endFrame: SR, sourceOffsetFrame: 0 },
      { startFrame: SR, endFrame: 2 * SR, sourceOffsetFrame: 30 * SR }
    ]
  })
  // Start 20 quanta short of the boundary, so the play fade is long finished.
  cmd(p, { type: 'seek', frame: SR - 2560 })
  cmd(p, { type: 'play' })
  const audio = capture(p, 40)
  let jump = 0
  for (let i = 2401; i < 3400; i++) jump = Math.max(jump, Math.abs(audio[i] - audio[i - 1]))
  ok('a region boundary does not click', jump < 0.02)
  ok('both sides of the boundary still play', Math.abs(audio[2400]) + Math.abs(audio[3399]) > 0)
}

// The uncut case is the one every performance deck uses, so it has to be the
// same audio and the same playhead as before regions existed.
{
  const plain = deck()
  const empty = deck()
  cmd(empty, { type: 'regions', regions: [] })
  cmd(plain, { type: 'play' })
  cmd(empty, { type: 'play' })
  let same = true
  const a = capture(plain, 100)
  const b = capture(empty, 100)
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) same = false
  ok('an empty region list plays the whole file unchanged', same && plain.pos === empty.pos)
}

// Playback ends at the end of the last region, not the end of the file.
{
  const p = deck()
  const ended = []
  p.port.postMessage = (m) => {
    if (m.type === 'ended') ended.push(m)
  }
  cmd(p, { type: 'regions', regions: GAPPED })
  cmd(p, { type: 'play' })
  render(p, 1200)
  eq('playback stops at the end of the last region', p.pos, 3 * SR, 0.51)
  ok('the deck reports it ended there', ended.length === 1 && !p.playing)
}

// Seeks are given timeline positions and must land on them, gap or not.
{
  const p = deck()
  cmd(p, { type: 'regions', regions: GAPPED })
  cmd(p, { type: 'seek', frame: 1.5 * SR })
  settle(p)
  eq('a seek into a gap lands where asked', p.pos, 1.5 * SR, 0.51)
  cmd(p, { type: 'seek', frame: 2.6 * SR })
  settle(p)
  eq('a seek across a gap lands where asked', p.pos, 2.6 * SR, 0.51)
  cmd(p, { type: 'seek', frame: 30 * SR })
  settle(p)
  eq('a seek past the last region clamps to the timeline end', p.pos, 3 * SR, 0.51)
}

// The whole point: after a cut, timeline seconds are not file seconds.
{
  const p = deck()
  cmd(p, { type: 'regions', regions: GAPPED })
  cmd(p, { type: 'seek', frame: 2.5 * SR })
  cmd(p, { type: 'play' })
  render(p, 40)
  const audio = capture(p, 1)
  // Timeline 2.5s sits 0.5s into a region that reads from 10s, plus the 40
  // quanta just rendered.
  const first = 10.5 * SR + 40 * 128
  let err = 0
  for (let i = 0; i < 128; i++) err = Math.max(err, Math.abs(audio[i] - source(first + i)))
  ok('a region reads from its source offset', err < 1e-6)
}
