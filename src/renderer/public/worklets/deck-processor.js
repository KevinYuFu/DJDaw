/**
 * DJDaw deck engine.
 *
 * A sample-position playback engine, which is how a CDJ works and what makes
 * hot cues, beat jump and scrubbing exact: the deck owns a fractional frame
 * playhead and every feature is expressed as "put the playhead here". Audio is
 * read with 4-point Hermite interpolation so off-speed playback stays clean,
 * and every discontinuity (seek, loop wrap, hot cue) is spliced with a short
 * equal-power crossfade so jumps never click.
 *
 * Plain JS on purpose: this file is handed to `audioWorklet.addModule` as-is.
 * The message contract is typed in `src/renderer/src/audio/deckProtocol.ts`.
 */

/** Crossfade applied across a playhead discontinuity, in frames (~5ms @48k). */
const SPLICE_FRAMES = 256
/** Play/pause fade, in seconds. */
const ENV_RAMP_SEC = 0.006
/** One-pole coefficient for tempo changes; keeps the fader from zippering. */
const RATE_SMOOTH = 0.002
/** Ceiling on scrub speed, in playback-rate multiples. */
const MAX_SCRUB_RATE = 24
/** How quickly the scrub velocity chases the pointer. */
const SCRUB_SMOOTH = 0.4
/** Scrub velocity, in rate multiples, at which scrub audio reaches full level. */
const SCRUB_FULL_LEVEL_RATE = 0.35

function hermite(y0, y1, y2, y3, t) {
  const c1 = 0.5 * (y2 - y0)
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2)
  return ((c3 * t + c2) * t + c1) * t + y1
}

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    /** @type {{ id: string, gain: number, channels: Float32Array[] }[]} */
    this.stems = []
    this.frames = 0
    this.srcRate = sampleRate

    this.pos = 0
    this.playing = false
    this.ended = false

    this.rateTarget = 1
    this.rate = 1

    this.gainTarget = 1
    this.gain = 1

    // Play/pause envelope.
    this.env = 0
    this.envTarget = 0
    this.envStep = 1 / Math.max(1, ENV_RAMP_SEC * sampleRate)
    /**
     * Where the playhead must settle once the declick fade finishes, or null
     * while the transport is moving under its own power. The fade deliberately
     * keeps rendering audio past the stopping point; this is what guarantees
     * the playhead still ends up frame-exact where it was commanded.
     */
    this.restPos = null

    // Splice crossfade state.
    this.spliceLeft = 0
    this.splicePos = 0
    this.spliceRate = 0

    this.loopEnabled = false
    this.loopStart = 0
    this.loopEnd = 0

    this.scrubbing = false
    this.scrubTarget = 0
    this.scrubVel = 0

    this.reportEvery = 3
    this.quantaSinceReport = 0

    this.port.onmessage = (e) => this.onCommand(e.data)
  }

  onCommand(msg) {
    switch (msg.type) {
      case 'load': {
        this.stems = msg.stems.map((s) => ({ id: s.id, gain: 1, channels: s.channels }))
        this.frames = msg.frames
        this.srcRate = msg.sampleRate || sampleRate
        this.pos = 0
        this.playing = false
        this.ended = false
        this.env = 0
        this.envTarget = 0
        this.restPos = null
        this.spliceLeft = 0
        this.loopEnabled = false
        this.port.postMessage({ type: 'loaded', frames: this.frames })
        break
      }
      case 'unload':
        this.stems = []
        this.frames = 0
        this.pos = 0
        this.playing = false
        this.envTarget = 0
        break
      case 'play':
        if (this.frames === 0) break
        if (this.pos >= this.frames - 1) this.pos = 0
        this.ended = false
        this.playing = true
        this.restPos = null
        this.envTarget = 1
        break
      case 'pause':
        if (!this.playing) break
        this.playing = false
        // Park the transport exactly here. The envelope keeps rolling for a
        // few milliseconds so the stop does not click, and the playhead is
        // rewound to this frame once it has.
        this.restPos = this.pos
        this.envTarget = 0
        break
      case 'seek':
        this.seekTo(msg.frame)
        break
      case 'rate':
        this.rateTarget = msg.rate
        break
      case 'gain':
        this.gainTarget = msg.gain
        break
      case 'stemGain': {
        const stem = this.stems.find((s) => s.id === msg.id)
        if (stem) stem.gain = msg.gain
        break
      }
      case 'loop':
        this.loopEnabled = msg.enabled
        this.loopStart = msg.startFrame
        this.loopEnd = msg.endFrame
        break
      case 'scrub':
        if (msg.active) {
          this.scrubbing = true
          this.scrubTarget = this.pos
          this.scrubVel = 0
        } else if (this.scrubbing) {
          this.scrubbing = false
          this.scrubVel = 0
          this.envTarget = this.playing ? 1 : 0
          // Letting go of the platter on a stopped deck parks it where the
          // hand left it. Without this the declick fade would keep advancing
          // the playhead, so every nudge would creep forward.
          if (!this.playing) this.restPos = this.pos
        }
        break
      case 'scrubTarget':
        this.scrubTarget = msg.frame
        break
      case 'reportInterval':
        this.reportEvery = Math.max(1, msg.quanta | 0)
        break
    }
  }

  /** Jump the playhead, arming a crossfade from the outgoing position. */
  seekTo(frame) {
    const target = Math.max(0, Math.min(this.frames, frame))
    if (this.env > 0.001) {
      this.splicePos = this.pos
      this.spliceRate = this.currentRate()
      this.spliceLeft = SPLICE_FRAMES
    }
    this.pos = target
    // A stopped deck must land exactly on the target. The declick fade from a
    // preceding pause is still running and still advancing the playhead, so
    // the seek target becomes the new parking spot rather than cancelling it —
    // pause-then-seek is how back-to-cue and every cue preview release work.
    this.restPos = this.playing || this.scrubbing ? null : target
    this.ended = false
    if (this.scrubbing) this.scrubTarget = target
  }

  currentRate() {
    if (this.scrubbing) return this.scrubVel
    return this.playing || this.envTarget > 0 ? this.rate : 0
  }

  /** One interpolated sample of one stem channel at a fractional frame. */
  readChannel(data, pos) {
    const i = Math.floor(pos)
    if (i < 0 || i >= this.frames) return 0
    const t = pos - i
    const n = data.length
    const y0 = i - 1 >= 0 ? data[i - 1] : data[0]
    const y1 = data[i]
    const y2 = i + 1 < n ? data[i + 1] : 0
    const y3 = i + 2 < n ? data[i + 2] : 0
    return hermite(y0, y1, y2, y3, t)
  }

  /** Sum every stem at `pos` into `out` (a 2-slot scratch array). */
  mixAt(pos, out) {
    let l = 0
    let r = 0
    for (let s = 0; s < this.stems.length; s++) {
      const stem = this.stems[s]
      const g = stem.gain
      if (g === 0) continue
      const ch = stem.channels
      const sl = this.readChannel(ch[0], pos)
      const sr = ch.length > 1 ? this.readChannel(ch[1], pos) : sl
      l += sl * g
      r += sr * g
    }
    out[0] = l
    out[1] = r
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const left = out[0]
    const right = out.length > 1 ? out[1] : out[0]
    const n = left.length

    if (this.stems.length === 0 || this.frames === 0) {
      left.fill(0)
      if (right !== left) right.fill(0)
      return true
    }

    // Scrub velocity is computed once per quantum from the pointer target.
    if (this.scrubbing) {
      const desired = Math.max(-MAX_SCRUB_RATE, Math.min(MAX_SCRUB_RATE, (this.scrubTarget - this.pos) / n))
      this.scrubVel += (desired - this.scrubVel) * SCRUB_SMOOTH
      if (Math.abs(this.scrubVel) < 1e-4) this.scrubVel = 0
      // A stationary platter is silent; level tracks how fast it is moving.
      this.envTarget = Math.min(1, Math.abs(this.scrubVel) / SCRUB_FULL_LEVEL_RATE)
    }

    const scratch = [0, 0]
    const spliceScratch = [0, 0]
    const moving = this.playing || this.scrubbing || this.env > 0.0001

    for (let i = 0; i < n; i++) {
      // Smooth the control signals.
      this.rate += (this.rateTarget - this.rate) * RATE_SMOOTH
      this.gain += (this.gainTarget - this.gain) * 0.002
      if (this.env < this.envTarget) this.env = Math.min(this.envTarget, this.env + this.envStep)
      else if (this.env > this.envTarget) this.env = Math.max(this.envTarget, this.env - this.envStep)

      let l = 0
      let r = 0
      if (moving || this.env > 0) {
        this.mixAt(this.pos, scratch)
        l = scratch[0]
        r = scratch[1]

        if (this.spliceLeft > 0) {
          // Equal-power crossfade from the pre-jump playhead.
          const t = 1 - this.spliceLeft / SPLICE_FRAMES
          const fadeIn = Math.sin(t * Math.PI * 0.5)
          const fadeOut = Math.cos(t * Math.PI * 0.5)
          this.mixAt(this.splicePos, spliceScratch)
          l = l * fadeIn + spliceScratch[0] * fadeOut
          r = r * fadeIn + spliceScratch[1] * fadeOut
          this.splicePos += this.spliceRate
          this.spliceLeft--
        }
      }

      const g = this.env * this.gain
      left[i] = l * g
      if (right !== left) right[i] = r * g

      // Advance the playhead.
      const step = this.scrubbing ? this.scrubVel : this.playing || this.env > 0 ? this.rate : 0
      if (step !== 0) {
        this.pos += step
        if (this.pos < 0) {
          this.pos = 0
          this.scrubVel = 0
        }

        if (this.loopEnabled && this.loopEnd > this.loopStart) {
          const len = this.loopEnd - this.loopStart
          if (this.pos >= this.loopEnd || this.pos < this.loopStart) {
            this.splicePos = this.pos
            this.spliceRate = step
            this.spliceLeft = SPLICE_FRAMES
            // Wrap by modulo rather than by subtracting one loop length. A
            // single playback step only ever overshoots by a fraction of a
            // frame, but a seek can land far outside the loop, and unwinding
            // that one length at a time would render a long burst of
            // discontinuous samples before the playhead re-entered.
            this.pos = this.loopStart + (((this.pos - this.loopStart) % len) + len) % len
          }
        }

        if (this.pos >= this.frames) {
          this.pos = this.frames
          if (this.playing) {
            this.playing = false
            this.envTarget = 0
            this.ended = true
          }
        }
      }
    }

    // The declick fade has finished: park the playhead exactly where the
    // transport was told to stop, undoing the few milliseconds the fade ran on.
    if (this.restPos !== null && this.env === 0) {
      this.pos = this.restPos
      this.restPos = null
    }

    if (this.ended) {
      this.ended = false
      this.port.postMessage({ type: 'ended', frame: this.pos })
    }

    if (++this.quantaSinceReport >= this.reportEvery) {
      this.quantaSinceReport = 0
      this.port.postMessage({
        type: 'state',
        frame: this.pos,
        playing: this.playing,
        scrubbing: this.scrubbing,
        rate: this.currentRate(),
        ctxTime: currentTime
      })
    }

    return true
  }
}

registerProcessor('deck-processor', DeckProcessor)
