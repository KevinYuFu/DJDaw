/**
 * The ffmpeg invocation used to decode a file.
 *
 * `-flags2 +skip_manual` is an input option: past `-i` ffmpeg reads it as an
 * output option and the padding is dropped anyway, silently.
 */
import { transcodeArgs } from './.build/ffmpegArgs.mjs'

const { eq, ok } = globalThis.__t

const plain = transcodeArgs('/music/a.mp3')
const whole = transcodeArgs('/music/a.mp3', true)

ok('the plain call does not ask for the padding', !plain.includes('+skip_manual'))
ok('the untrimmed one does', whole.includes('+skip_manual'))

// Order is the whole point: this flag only works ahead of -i.
{
  const flag = whole.indexOf('-flags2')
  const input = whole.indexOf('-i')
  ok('the flag is there', flag >= 0)
  ok('and it comes before the input', flag < input)
  eq('with its value straight after it', whole[flag + 1], '+skip_manual')
}

eq('the path follows -i', whole[whole.indexOf('-i') + 1], '/music/a.mp3')
eq('the output is a float wav', whole.slice(-5).join(' '), '-f wav -acodec pcm_f32le -')
eq('and it goes to stdout', whole[whole.length - 1], '-')

// Adding the flag must not disturb anything else.
eq(
  'the two calls differ only by the flag',
  whole.filter((a) => a !== '-flags2' && a !== '+skip_manual').join(' '),
  plain.join(' ')
)

// A path that looks like a flag is still a path.
{
  const odd = transcodeArgs('-i.mp3', true)
  eq('a path is passed as one argument', odd[odd.indexOf('-i') + 1], '-i.mp3')
}
