/**
 * A piece dropped on another row is drawn from the file it carries.
 *
 * The row it landed on has different audio at that moment, so drawing from the
 * row would show the wrong sound entirely. Two envelopes with nothing in
 * common make it obvious which one was read.
 */
import { buildClipColumns, buildClipExtents } from './.build/waveformRender.mjs'

const { ok } = globalThis.__t

const SAMPLE_RATE = 48000
const BUCKET = 128
const BUCKETS_PER_SEC = SAMPLE_RATE / BUCKET

/** An envelope that is flat at `level` all the way through. */
const wave = (level, seconds = 60) => {
  const count = Math.round(seconds * BUCKETS_PER_SEC)
  const band = new Uint8Array(count).fill(level)
  return {
    version: 1,
    bucketSize: BUCKET,
    sampleRate: SAMPLE_RATE,
    bucketCount: count,
    peak: 1,
    low: band,
    mid: band,
    high: band
  }
}

/** Audio that is a steady tone at `level`, alternating sign every sample. */
const channels = (level, seconds = 60) => {
  const data = new Float32Array(Math.round(seconds * SAMPLE_RATE))
  for (let i = 0; i < data.length; i++) data[i] = i % 2 === 0 ? level : -level
  return [data]
}

const clip = (id, startSec, durationSec, sourceOffsetSec, sourceId) => ({
  id,
  startSec,
  durationSec,
  sourceOffsetSec,
  ...(sourceId ? { sourceId } : {})
})

// Row audio is quiet; the piece dropped in from elsewhere is loud.
const rowWave = wave(40)
const guestWave = wave(200)
const clips = [clip('own', 0, 10, 0), clip('guest', 10, 10, 0, 'guest-track'), clip('own2', 20, 10, 10)]

{
  const cols = buildClipColumns(rowWave, clips, 0, 30, 30, SAMPLE_RATE, null, undefined, (id) =>
    id === 'guest-track' ? guestWave : null
  )
  // Bands come back as 0-1, so 40 and 200 out of 255 land near .16 and .78.
  const at = (sec) => cols.low[Math.floor(sec)]
  ok(`the row's own audio keeps the row's envelope — ${at(5).toFixed(3)}`, Math.abs(at(5) - 40 / 255) < 0.01)
  ok(`the piece from elsewhere is drawn loud — ${at(15).toFixed(3)}`, Math.abs(at(15) - 200 / 255) < 0.01)
  ok(`the row goes back to its own after it — ${at(25).toFixed(3)}`, Math.abs(at(25) - 40 / 255) < 0.01)
}

{
  // With no resolver every piece falls back to the row, which is what a row
  // that has never been dropped on looks like.
  const cols = buildClipColumns(rowWave, clips, 0, 30, 30, SAMPLE_RATE)
  ok(`without one, the guest is drawn from the row — ${cols.low[15].toFixed(3)}`,
    Math.abs(cols.low[15] - 40 / 255) < 0.01)
}

{
  const rowAudio = channels(0.1)
  const guestAudio = channels(0.9)
  const ext = buildClipExtents(rowAudio, clips, 0, 30, 30, SAMPLE_RATE, null, undefined, (id) =>
    id === 'guest-track' ? guestAudio : null
  )
  ok(`the row's own samples are read for its own pieces — ${ext.max[5].toFixed(2)}`,
    Math.abs(ext.max[5] - 0.1) < 0.02)
  ok(`the piece from elsewhere reads its own samples — ${ext.max[15].toFixed(2)}`,
    Math.abs(ext.max[15] - 0.9) < 0.02)
  ok(`and its RMS comes from them too — ${ext.rms[15].toFixed(2)}`,
    Math.abs(ext.rms[15] - 0.9) < 0.02)
  ok(`the piece after it is the row's again — ${ext.max[25].toFixed(2)}`,
    Math.abs(ext.max[25] - 0.1) < 0.02)
}
