/**
 * The ffmpeg invocation that turns an audio file into a float WAV.
 *
 * `untrimmed` keeps the encoder padding a compressed stream carries at each
 * end. A gapless decoder drops it; an imported beat grid is written against
 * the stream with it in place, so dropping it lands every position early.
 */
export function transcodeArgs(path: string, untrimmed = false): string[] {
  return [
    '-v',
    'error',
    // Applies to the input, so it has to come before -i.
    ...(untrimmed ? ['-flags2', '+skip_manual'] : []),
    '-i',
    path,
    '-f',
    'wav',
    '-acodec',
    'pcm_f32le',
    '-'
  ]
}
