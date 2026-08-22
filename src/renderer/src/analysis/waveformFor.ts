import type { WaveformData } from '@shared/types'
import { analyzeWaveform, decodeWaveform, encodeWaveform } from '@renderer/analysis/waveform'

/**
 * The envelope for a file: from the cache when it still matches that audio,
 * and from a fresh analysis when it does not.
 *
 * Keyed on the audio rather than on whoever asked, so a file opened on a deck
 * and again in the arrangement is analysed once.
 */
/**
 * Does a cached waveform actually summarise this audio? The cache is keyed on
 * the audio path alone, so a file swapped out at the same path — a re-encode,
 * a different song, an edit — still finds the old entry and would be drawn
 * over completely unrelated audio. The header is enough to catch it: the
 * analyser emits one bucket per `bucketSize` frames of the buffer it was given.
 */
function cacheMatchesAudio(w: WaveformData, buffer: AudioBuffer): boolean {
  if (w.sampleRate !== buffer.sampleRate) return false
  if (!(w.bucketSize > 0)) return false
  return w.bucketCount === Math.ceil(buffer.length / w.bucketSize)
}

/**
 * Cached waveform if there is one, otherwise analyse and cache the result.
 *
 * Keyed on `audioKey`, not on the track id: a mirrored record and any local
 * fork of it are the same file, so the fork inherits the analysis instead of
 * spending seconds re-deriving an identical waveform.
 */
export async function resolveWaveform(audioKey: string, path: string, buffer: AudioBuffer): Promise<WaveformData | null> {
  try {
    const cached = await window.api.readWaveformCache(audioKey)
    if (cached) {
      const decoded = decodeWaveform(cached)
      if (decoded && cacheMatchesAudio(decoded, buffer)) return decoded
      if (decoded) console.warn('[waveform]  cache does not match the audio, re-analysing', path)
    }
  } catch (err) {
    // A missing or corrupt cache file is not a reason to fail the load.
    console.warn('[waveform]  cache read failed', err)
  }
  try {
    const waveform = await analyzeWaveform(buffer)
    try {
      await window.api.writeWaveformCache(audioKey, encodeWaveform(waveform))
    } catch (err) {
      console.warn('[waveform]  cache write failed', err)
    }
    return waveform
  } catch (err) {
    console.error('[waveform]  analysis failed', err)
    return null
  }
}
