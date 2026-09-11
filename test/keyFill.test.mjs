/**
 * Taking a key from the rekordbox mirror.
 *
 * The same file can sit in both collections. Where rekordbox states a key and
 * the local record has none, the local record takes it — and never the other
 * way round, because a key already there was detected or set by hand.
 */
import { keysFromMirror, localIdFor, rekordboxIdFor } from './.build/collection.mjs'

const { eq, ok } = globalThis.__t

/** Just the fields the fill reads. */
const track = (audioKey, key, source = 'local') => ({
  id: source === 'local' ? localIdFor(audioKey) : rekordboxIdFor(audioKey),
  audioKey,
  key,
  source
})

const asMap = (list) => Object.fromEntries(list.map((t) => [t.id, t]))

// ------------------------------------------------------------- filling a gap

{
  const local = asMap([track('aaa', null)])
  const mirror = asMap([track('aaa', '2A', 'rekordbox')])
  const fills = keysFromMirror(local, mirror)
  eq('a local record with no key takes rekordbox’s', fills[localIdFor('aaa')], '2A')
  eq('and only that one', Object.keys(fills).length, 1)
}

// --------------------------------------------------------- leaving one alone

{
  const local = asMap([track('aaa', '8A')])
  const mirror = asMap([track('aaa', '2A', 'rekordbox')])
  eq('a key already there is never overwritten', Object.keys(keysFromMirror(local, mirror)).length, 0)
}

// ------------------------------------------------------------- no counterpart

{
  const local = asMap([track('aaa', null)])
  const mirror = asMap([track('bbb', '2A', 'rekordbox')])
  eq('a different file fills nothing', Object.keys(keysFromMirror(local, mirror)).length, 0)
}

{
  const local = asMap([track('aaa', null)])
  const mirror = asMap([track('aaa', null, 'rekordbox')])
  eq('a mirrored record with no key fills nothing', Object.keys(keysFromMirror(local, mirror)).length, 0)
}

// ------------------------------------------------------------------- nothing

eq('an empty mirror fills nothing', Object.keys(keysFromMirror(asMap([track('aaa', null)]), {})).length, 0)
eq('an empty collection takes nothing', Object.keys(keysFromMirror({}, asMap([track('aaa', '2A', 'rekordbox')]))).length, 0)

// --------------------------------------------------------------- a few at once

{
  const local = asMap([track('a', null), track('b', '5A'), track('c', null), track('d', null)])
  const mirror = asMap([
    track('a', '1A', 'rekordbox'),
    track('b', '9B', 'rekordbox'),
    track('c', null, 'rekordbox')
  ])
  const fills = keysFromMirror(local, mirror)
  eq('only the gaps rekordbox can answer are filled', Object.keys(fills).length, 1)
  eq('and it is the right one', fills[localIdFor('a')], '1A')
  ok('the one with a key is untouched', !(localIdFor('b') in fills))
  ok('the one rekordbox cannot answer is untouched', !(localIdFor('c') in fills))
  ok('the one rekordbox has never seen is untouched', !(localIdFor('d') in fills))
}
