/**
 * Arrangement voice behaviour, driven under Node with stubbed AudioWorklet
 * globals so positions can be asserted frame-exactly.
 *
 * The property everything else rests on: arrangement time advances at exactly
 * one frame per frame whatever the clip's speed is. That is what keeps lanes
 * locked to each other, so speed has to show up in the source lookup and
 * nowhere else.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { eq, ok } = globalThis.__t

const SR = 48000
let Processor = null
globalThis.sampleRate = SR
globalThis.currentTime = 0
globalThis.currentFrame = 0
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { postMessage() {}, onmessage: null }
  }
}
globalThis.registerProcessor = (_name, cls) => {
  Processor = cls
}

const here = dirname(fileURLToPath(import.meta.url))
const worklet = join(here, '..', 'src', 'renderer', 'public', 'worklets', 'voice-processor.js')
new Function(readFileSync(worklet, 'utf8'))()

const FRAMES = SR * 60

/** A voice loaded with a ramp, so a sample's value names the frame it came from. */
function voice(clips, rate = 1) {
  globalThis.currentFrame = 0
  const p = new Processor()
  const ch = new Float32Array(FRAMES)
  for (let i = 0; i < FRAMES; i++) ch[i] = i
  p.port.onmessage({ data: { type: 'load', channels: [ch, ch], frames: FRAMES } })
  p.port.onmessage({ data: { type: 'clips', clips } })
  p.port.onmessage({ data: { type: 'rate', rate } })
  return p
}

function quantum() {
  return [[new Float32Array(128), new Float32Array(128)]]
}

/** Run `n` render quanta, advancing the context frame counter as a host would. */
function render(p, n) {
  const out = quantum()
  for (let i = 0; i < n; i++) {
    p.process([], out)
    globalThis.currentFrame += 128
  }
  return out[0]
}

const whole = [{ start: 0, end: SR * 30, src: 0 }]

// A stopped voice sits exactly where it was put.
{
  const p = voice(whole)
  p.port.onmessage({ data: { type: 'seek', frame: 1000 } })
  render(p, 4)
  eq('a stopped voice does not move', p.pos, 1000)
}

// Arrangement time runs at one frame per frame, whatever the clip speed is.
for (const rate of [1, 1.16, 0.82, 2]) {
  const p = voice(whole, rate)
  p.port.onmessage({ data: { type: 'transport', playing: true, fromFrame: 0, atContextFrame: 0 } })
  render(p, 10)
  eq(`arrangement time ignores rate ${rate}`, p.pos, 1280)
}

// Speed lives in the source lookup instead.
{
  const p = voice(whole, 1.16)
  eq('a clip starts at its own source offset', p.sourceOf(0, 0), 0)
  eq('a warped clip reads ahead of arrangement time', p.sourceOf(0, 1000), 1160)
  const slow = voice(whole, 0.5)
  eq('a slowed clip reads behind it', slow.sourceOf(0, 1000), 500)
}

// A clip that starts part-way in reads from its own offset, not the file start.
{
  const p = voice([{ start: 4800, end: 9600, src: 96000 }], 1)
  eq('before the clip is a gap', p.resolveClip(0), -1)
  eq('inside the clip resolves to it', p.resolveClip(5000), 0)
  eq('the end of a clip is not part of it', p.resolveClip(9600), -1)
  eq('the clip starts where it says it does', p.sourceOf(0, 4800), 96000)
  eq('and runs on from there', p.sourceOf(0, 5800), 97000)
}

// Two clips from the same source, laid apart, with a gap between them.
{
  const clips = [
    { start: 0, end: 1000, src: 0 },
    { start: 5000, end: 6000, src: 480000 }
  ]
  const p = voice(clips)
  eq('the first piece', p.resolveClip(500), 0)
  eq('the gap between them is silent', p.resolveClip(3000), -1)
  eq('the second piece', p.resolveClip(5500), 1)
  eq('and it reads its own part of the file', p.sourceOf(1, 5500), 480500)
}

// A start is scheduled: nothing sounds before the named context frame.
{
  const p = voice(whole)
  globalThis.currentFrame = 0
  p.port.onmessage({
    data: { type: 'transport', playing: true, fromFrame: 0, atContextFrame: 640 }
  })
  const out = quantum()
  for (let i = 0; i < 5; i++) {
    p.process([], out)
    globalThis.currentFrame += 128
  }
  eq('the playhead waits for the scheduled frame', p.pos, 0)
  ok('and the voice is not running yet', !p.playing)

  p.process([], out)
  ok('it starts on the quantum holding that frame', p.playing)
  ok('and the playhead moves from then on', p.pos > 0)
}

// Two voices told to start on the same context frame stay in step forever.
{
  const a = voice(whole, 1)
  const b = voice(whole, 1.16)
  globalThis.currentFrame = 0
  for (const p of [a, b]) {
    p.port.onmessage({
      data: { type: 'transport', playing: true, fromFrame: 0, atContextFrame: 300 }
    })
  }
  const out = quantum()
  for (let i = 0; i < 200; i++) {
    a.process([], out)
    b.process([], out)
    globalThis.currentFrame += 128
  }
  eq('voices at different speeds keep the same arrangement position', a.pos, b.pos)
}

// Past the end of the file a clip is silent rather than reading rubbish.
{
  const p = voice([{ start: 0, end: SR * 90, src: 0 }])
  eq('reads past the file are silent', p.readChannel(new Float32Array([1, 2, 3]), FRAMES + 10), 0)
}
