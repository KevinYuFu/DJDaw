/**
 * Turning a file path into an AudioBuffer.
 *
 * Chromium decodes the common DJ formats (mp3, m4a/AAC, flac, wav, ogg) but
 * refuses plenty of things that turn up in a real library — AIFF variants,
 * ALAC, 24-bit oddities, files with damaged headers. Those go through the
 * ffmpeg sidecar in the main process instead, which hands back a plain float
 * WAV that Chromium always accepts.
 *
 * A compressed file also carries a little of the encoder's own silence at each
 * end. Chromium drops it, which is right for gapless playback and wrong here:
 * an imported beat grid is written against the stream with that silence in
 * place, so dropping it lands every position in the file early. Those formats
 * take the sidecar too, which is told to leave the stream whole.
 */

/** Formats that carry encoder padding, and so must not be decoded natively. */
const PADDED_FORMATS: readonly string[] = ['.mp3']

/** Whether `path` names a file whose stream has padding to preserve. */
export function hasEncoderPadding(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return PADDED_FORMATS.includes(path.slice(dot).toLowerCase())
}

/**
 * Decode `path` into an AudioBuffer at `ctx`'s sample rate, falling back to an
 * ffmpeg transcode when the browser decoder refuses the file.
 *
 * @throws Error naming the file and both failure reasons if neither route works.
 */
export async function decodeTrack(ctx: BaseAudioContext, path: string): Promise<AudioBuffer> {
  if (hasEncoderPadding(path)) {
    try {
      return await ctx.decodeAudioData(await window.api.transcodeToWav(path, true))
    } catch (err) {
      // A track that plays a few milliseconds early beats one that will not
      // load at all, so the native route still gets its turn below.
      console.warn('[decode] untrimmed decode failed, falling back', path, reasonOf(err))
    }
  }

  let nativeReason = 'unknown error'
  try {
    const bytes = await window.api.readAudioFile(path)
    // decodeAudioData detaches `bytes`, so it is dead memory from here on. The
    // fallback below fetches its own copy.
    return await ctx.decodeAudioData(bytes)
  } catch (err) {
    nativeReason = reasonOf(err)
  }

  try {
    const wav = await window.api.transcodeToWav(path)
    return await ctx.decodeAudioData(wav)
  } catch (err) {
    throw new Error(
      `Could not load "${path}" — browser decode failed (${nativeReason}), ` +
        `ffmpeg fallback failed (${reasonOf(err)})`,
      { cause: err }
    )
  }
}

/** Best-effort human-readable reason out of an unknown throw value. */
function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  // DOMException from decodeAudioData, and IPC errors, are not always
  // instanceof Error across realms; read the message off them anyway.
  if (typeof err === 'object' && err !== null && 'message' in err) return String(err.message)
  return String(err)
}
