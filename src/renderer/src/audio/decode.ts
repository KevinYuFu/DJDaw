/**
 * Turning a file path into an AudioBuffer.
 *
 * Chromium decodes the common DJ formats (mp3, m4a/AAC, flac, wav, ogg) but
 * refuses plenty of things that turn up in a real library — AIFF variants,
 * ALAC, 24-bit oddities, files with damaged headers. Those go through the
 * ffmpeg sidecar in the main process instead, which hands back a plain float
 * WAV that Chromium always accepts.
 */

/**
 * Decode `path` into an AudioBuffer at `ctx`'s sample rate, falling back to an
 * ffmpeg transcode when the browser decoder refuses the file.
 *
 * @throws Error naming the file and both failure reasons if neither route works.
 */
export async function decodeTrack(ctx: BaseAudioContext, path: string): Promise<AudioBuffer> {
  let nativeReason = 'unknown error'
  try {
    const bytes = await window.api.readAudioFile(path)
    // decodeAudioData detaches `bytes`, so it is dead memory from here on:
    // the fallback below deliberately fetches its own copy of the audio
    // rather than trying to reuse this one.
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
