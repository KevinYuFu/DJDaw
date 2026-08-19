/**
 * Downbeat detection: the bar line, not the beat.
 *
 * Every case is synthesised, so the right answer is known to the sample. They
 * are all built the same way: a beat grid starting at OFFSET, and a kick
 * pattern whose bar line sits a known number of beats into that grid. The
 * detector has to come back with that bar line.
 *
 * All five fail against a downbeat picked by summed low-band energy, which is
 * what this replaced. They pass with Pioneer's method (JP6071274B2): vote only
 * on the kick that starts the track and the kick that ends each break.
 */

// The worker installs an onmessage handler on `self` as it loads.
globalThis.self = { postMessage() {} }
const { detect } = await import('./.build/bpm.worker.mjs')

const { eq, ok } = globalThis.__t

const SR = 44100
const BPM = 128
/** Seconds per beat. */
const B = 60 / BPM
/** Where beat 0 of the grid sits. Not a round number on purpose. */
const OFFSET = 0.35
/** Half a beat of slack: enough to catch a wrong beat, loose on filter delay. */
const TOL = B / 2

const beat = (i) => OFFSET + i * B

function make(beats) {
  return new Float32Array(Math.round((beat(beats) + 1) * SR))
}

/** 45 Hz kick with a short pitch drop on the front. */
function kick(buf, at, amp = 1) {
  const start = Math.round(at * SR)
  const n = Math.round(0.25 * SR)
  for (let i = 0; i < n; i++) {
    const j = start + i
    if (j >= buf.length) break
    const t = i / SR
    buf[j] += amp * Math.exp(-t / 0.09) * Math.sin(2 * Math.PI * (45 + 80 * Math.exp(-t / 0.02)) * t)
  }
}

let seed = 7
/** Hi-hat: differenced noise, so it puts almost nothing under 150 Hz. */
function hat(buf, at, amp = 0.3) {
  const start = Math.round(at * SR)
  const n = Math.round(0.05 * SR)
  let prev = 0
  for (let i = 0; i < n; i++) {
    const j = start + i
    if (j >= buf.length) break
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const v = seed / 0x3fffffff - 1
    buf[j] += amp * Math.exp(-(i / SR) / 0.012) * (v - prev)
    prev = v
  }
}

/** Sustained two-note pad over `[from, to)` beats. No transient, no kick. */
function pad(buf, from, to, freq) {
  const a = Math.round(beat(from) * SR)
  const b = Math.min(buf.length, Math.round(beat(to) * SR))
  for (let j = a; j < b; j++) {
    const t = (j - a) / SR
    const fade = Math.min(1, t / 0.02, (b - j) / SR / 0.02)
    buf[j] += 0.18 * fade * (Math.sin(2 * Math.PI * freq * t) + 0.6 * Math.sin(3 * Math.PI * freq * t))
  }
}

/**
 * Assert the detected grid: the tempo, and the bar line `barBeat` beats into
 * the grid. `firstBeatTime` is the first downbeat at or after t=0, so the
 * comparison is modulo one bar.
 */
function check(name, buf, barBeat) {
  const r = detect(buf, SR)
  eq(`${name}: tempo`, r.bpm, BPM, 0.05)

  const bar = 4 * B
  ok(`${name}: downbeat is in the first bar`, r.firstBeatTime >= 0 && r.firstBeatTime < bar + 1e-6)

  let err = r.firstBeatTime - beat(barBeat)
  err -= Math.round(err / bar) * bar
  eq(`${name}: downbeat`, err, 0, TOL)
}

// 1. Kick on every beat. The track starts on the bar line.
{
  const n = 64
  const buf = make(n)
  for (let i = 0; i < n; i++) {
    kick(buf, beat(i))
    hat(buf, beat(i) + B / 2)
  }
  check('kick every beat', buf, 0)
}

// 2. Kick on beats 1 and 3 only, hats keeping the beat. The bar line is two
//    beats in, so the kick spacing (two beats) has to be accepted as a valid
//    pattern and the first kick has to carry the phase.
{
  const n = 72
  const buf = make(n)
  for (let i = 0; i < n; i++) {
    hat(buf, beat(i))
    if (i >= 2 && (i - 2) % 2 === 0) kick(buf, beat(i))
  }
  check('kick on 1 and 3', buf, 2)
}

// 3. Eight bars of ambient pad, no kick at all, then the drums enter on the
//    downbeat. The pad changes chord every four beats on the wrong phase, so
//    the low band is full of energy pointing at the wrong answer. Only the
//    drum entry knows where the bar is.
{
  const n = 96
  const buf = make(n)
  const notes = [110, 130.8, 146.8, 98]
  for (let c = 0; c * 4 < 34; c++) pad(buf, c * 4, Math.min(34, (c + 1) * 4), notes[c % 4])
  for (let i = 34; i < n; i++) {
    kick(buf, beat(i))
    hat(buf, beat(i) + B / 2)
  }
  check('ambient intro', buf, 2)
}

// 4. A 16-beat break in the middle, then the kick re-enters on the downbeat.
{
  const n = 96
  const buf = make(n)
  for (let i = 0; i < n; i++) hat(buf, beat(i))
  for (let i = 2; i < 34; i++) kick(buf, beat(i))
  for (let i = 50; i < n; i++) kick(buf, beat(i))
  pad(buf, 34, 50, 110)
  check('mid-track break', buf, 2)
}

// 5. The first kick in the track is a stray stab off the bar line, followed by
//    nothing for fourteen beats. It must not vote: no second kick follows it at
//    a beat spacing. The real drum entry decides instead.
{
  const n = 96
  const buf = make(n)
  for (let i = 0; i < n; i++) hat(buf, beat(i))
  kick(buf, beat(1), 1.1)
  for (let i = 15; i < n; i++) kick(buf, beat(i))
  check('stray first kick', buf, 3)
}
