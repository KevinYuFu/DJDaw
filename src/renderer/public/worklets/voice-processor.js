/**
 * DJDaw arrangement voice.
 *
 * One audio source, playing the pieces of itself that belong to one lane.
 *
 * The playhead is arrangement time and it always advances at exactly one frame
 * per frame — that is what keeps every voice in the session locked together no
 * matter what tempo anything was recorded at. Speed lives on the clip instead:
 * a clip says which source frame it starts at and how many source frames to
 * consume per arrangement frame, so a 174 BPM track laid on a 123 BPM grid is
 * read slowly while the grid keeps ticking.
 *
 * A voice holds one source at one rate, so the pitch shift that cancels the
 * speed change is a single constant — see `Voice` for the stretcher that
 * applies it.
 *
 * Audio is read with 4-point Hermite interpolation, and every discontinuity —
 * a seek, or the jump from the end of one clip to the start of the next — is
 * spliced with a short equal-power crossfade so it never clicks.
 *
 * Plain JS on purpose: this file is handed to `audioWorklet.addModule` as-is.
 * The message contract is typed in `src/renderer/src/audio/voiceProtocol.ts`.
 */

/** Crossfade applied across a playhead discontinuity, in frames (~5ms @48k). */
const SPLICE_FRAMES = 256

/** Play/pause fade, in seconds. */
const ENV_RAMP_SEC = 0.006

/** How often the voice reports its playhead, in render quanta. */
const REPORT_QUANTA = 8

function hermite(y0, y1, y2, y3, t) {
  const c1 = 0.5 * (y2 - y0)
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2)
  return ((c3 * t + c2) * t + c1) * t + y1
}

class VoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    /** @type {Float32Array[]} */
    this.channels = []
    this.frames = 0

    /**
     * The pieces of the source this voice plays, in arrangement order.
     *
     * `start`/`end` are arrangement frames, `src` is the source frame the piece
     * begins at. Kept sorted and non-overlapping by the renderer.
     */
    this.clips = []
    /** Source frames consumed per arrangement frame. */
    this.rate = 1

    /** Arrangement playhead, in frames. Fractional while a clip is warped. */
    this.pos = 0
    this.playing = false
    /** Context frame the transport starts on, for a sample-accurate start. */
    this.startsAt = -1

    /** Index of the clip under the playhead, or -1 in a gap. */
    this.clipIndex = -1
    /** Search hint, so finding the clip is O(1) while the playhead runs. */
    this.cursor = 0
    /** Source frame the last sample was read from, to splice from on a jump. */
    this.lastSrc = null

    /** Outgoing tail of a splice: where it reads from and how much is left. */
    this.splicePos = null
    this.spliceLeft = 0

    /** Play/pause envelope, so starting and stopping never click. */
    this.env = 0
    this.envTarget = 0
    this.envStep = 1 / Math.max(1, ENV_RAMP_SEC * sampleRate)

    this.quanta = 0

    this.port.onmessage = (e) => this.onCommand(e.data)
  }

  onCommand(msg) {
    switch (msg.type) {
      case 'load':
        this.channels = msg.channels.map((c) => new Float32Array(c))
        this.frames = msg.frames | 0
        this.syncClip()
        break

      case 'clips':
        this.clips = Array.isArray(msg.clips) ? msg.clips : []
        this.cursor = 0
        this.syncClip()
        break

      case 'rate':
        if (Number.isFinite(msg.rate) && msg.rate > 0) this.rate = msg.rate
        break

      case 'transport':
        // A start is scheduled on a context frame so every voice in the
        // session begins on the same sample, however they were created.
        if (msg.playing) {
          this.pos = msg.fromFrame
          this.startsAt = msg.atContextFrame
          this.syncClip()
        } else {
          this.playing = false
          this.startsAt = -1
          this.envTarget = 0
        }
        break

      case 'seek':
        this.seekTo(msg.frame)
        break

      default:
        break
    }
  }

  /** Re-seat the clip state on the playhead without arming a splice. */
  syncClip() {
    this.clipIndex = this.resolveClip(this.pos)
    this.lastSrc = this.sourceOf(this.clipIndex, this.pos)
  }

  /**
   * Index of the clip covering an arrangement position, or -1 for a gap.
   *
   * Walks from the last answer rather than searching: the playhead moves by one
   * frame at a time, so both loops normally exit immediately.
   */
  resolveClip(pos) {
    const clips = this.clips
    const n = clips.length
    if (n === 0) return -1
    let i = this.cursor
    if (i < 0) i = 0
    else if (i >= n) i = n - 1
    while (i > 0 && pos < clips[i].start) i--
    while (i < n - 1 && pos >= clips[i].end) i++
    this.cursor = i
    const c = clips[i]
    return pos >= c.start && pos < c.end ? i : -1
  }

  /** Source frame an arrangement position reads from, or null in a gap. */
  sourceOf(index, pos) {
    if (index < 0) return null
    const c = this.clips[index]
    return c.src + (pos - c.start) * this.rate
  }

  /**
   * Source frame for this sample, arming a crossfade when the playhead has
   * just crossed into a different clip.
   *
   * A clip boundary is a source discontinuity like any other jump, so it gets
   * the same treatment as a seek: the outgoing piece keeps playing under the
   * incoming one for a few milliseconds instead of stopping dead.
   */
  sourceUnderPlayhead() {
    const index = this.resolveClip(this.pos)
    if (index !== this.clipIndex) {
      if (this.env > 0.001 && this.lastSrc !== null) {
        this.splicePos = this.lastSrc + this.rate
        this.spliceLeft = SPLICE_FRAMES
      }
      this.clipIndex = index
    }
    const src = this.sourceOf(index, this.pos)
    this.lastSrc = src
    return src
  }

  /** Jump the playhead, arming a crossfade from the outgoing position. */
  seekTo(frame) {
    if (this.env > 0.001 && this.lastSrc !== null) {
      this.splicePos = this.lastSrc
      this.spliceLeft = SPLICE_FRAMES
    }
    this.pos = Math.max(0, frame)
    this.cursor = 0
    this.syncClip()
  }

  /** One channel at a source frame. Silent past either end of the file. */
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

  /** The source at a frame, as a stereo pair in `out`. */
  readAt(pos, out) {
    const ch = this.channels
    const l = this.readChannel(ch[0], pos)
    out[0] = l
    out[1] = ch.length > 1 ? this.readChannel(ch[1], pos) : l
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const left = out[0]
    const right = out.length > 1 ? out[1] : out[0]
    const n = left.length

    // A scheduled start lands mid-quantum as often as not; the frames before it
    // stay silent so every voice hears its first sample at the same instant.
    let startAt = 0
    if (this.startsAt >= 0) {
      const offset = this.startsAt - currentFrame
      if (offset >= n) {
        left.fill(0)
        if (right !== left) right.fill(0)
        return true
      }
      startAt = Math.max(0, offset)
      this.startsAt = -1
      this.playing = true
      this.envTarget = 1
    }

    if (this.channels.length === 0 || this.frames === 0) {
      left.fill(0)
      if (right !== left) right.fill(0)
      return true
    }

    const scratch = [0, 0]
    const tail = [0, 0]
    const moving = this.playing || this.env > 0.0001

    for (let i = 0; i < n; i++) {
      if (i < startAt || !moving) {
        left[i] = 0
        if (right !== left) right[i] = 0
        continue
      }

      if (this.env < this.envTarget) this.env = Math.min(this.envTarget, this.env + this.envStep)
      else if (this.env > this.envTarget) this.env = Math.max(this.envTarget, this.env - this.envStep)

      const src = this.sourceUnderPlayhead()
      if (src === null) {
        scratch[0] = 0
        scratch[1] = 0
      } else {
        this.readAt(src, scratch)
      }

      // The outgoing side of a splice keeps reading straight on, so the two
      // sides are both real audio and the crossfade between them is inaudible.
      if (this.spliceLeft > 0 && this.splicePos !== null) {
        this.readAt(this.splicePos, tail)
        const t = this.spliceLeft / SPLICE_FRAMES
        const fadeOut = Math.sqrt(t)
        const fadeIn = Math.sqrt(1 - t)
        scratch[0] = scratch[0] * fadeIn + tail[0] * fadeOut
        scratch[1] = scratch[1] * fadeIn + tail[1] * fadeOut
        this.splicePos += this.rate
        this.spliceLeft--
      }

      const g = this.env
      left[i] = scratch[0] * g
      if (right !== left) right[i] = scratch[1] * g

      // Arrangement time, always at one frame per frame.
      if (this.playing) this.pos += 1
    }

    if (!this.playing && this.env <= 0.0001) this.env = 0

    this.quanta++
    if (this.quanta >= REPORT_QUANTA) {
      this.quanta = 0
      this.port.postMessage({ type: 'pos', frame: this.pos, playing: this.playing })
    }
    return true
  }
}

registerProcessor('voice-processor', VoiceProcessor)
