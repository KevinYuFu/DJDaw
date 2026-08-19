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
