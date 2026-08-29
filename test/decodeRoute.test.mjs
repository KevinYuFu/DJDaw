/**
 * Which decoder a file goes to.
 *
 * A format that carries encoder padding must not be decoded natively: the
 * native decoder drops that padding, and an imported beat grid counts it as
 * part of the track.
 */
import { hasEncoderPadding } from './.build/decode.mjs'

const { ok } = globalThis.__t

ok('an mp3 keeps its padding', hasEncoderPadding('/music/track.mp3'))
ok('whatever case it is written in', hasEncoderPadding('/music/TRACK.MP3'))
ok('and wherever the dots fall', hasEncoderPadding('/music/a.b.c/my. track.Mp3'))

ok('a wav has none to keep', !hasEncoderPadding('/music/track.wav'))
ok('nor a flac', !hasEncoderPadding('/music/track.flac'))
ok('nor an aiff', !hasEncoderPadding('/music/track.aiff'))

// A name that merely mentions the format is not the format.
ok('a name containing mp3 is not an mp3', !hasEncoderPadding('/music/mp3 rips/track.wav'))
ok('nor one ending in the letters', !hasEncoderPadding('/music/track-mp3'))
ok('a file with no extension is left alone', !hasEncoderPadding('/music/track'))
ok('and so is an empty path', !hasEncoderPadding(''))
