/**
 * Copy-on-write between the rekordbox mirror and the local collection.
 *
 * The invariants that matter: an edit to a mirrored track must never reach the
 * mirror, a second edit must reuse the existing fork instead of resetting the
 * first one, and a fork must keep the audio key so it inherits the waveform
 * rather than re-analysing the same file.
 */
import * as C from './.build/collection.mjs'

const { eq, ok } = globalThis.__t

const KEY = 'a'.repeat(40)

const mirrored = () => ({
  id: C.rekordboxIdFor(KEY),
  source: 'rekordbox',
  audioKey: KEY,
  path: '/Users/x/Music/track.mp3',
  title: 'Track',
  artist: 'Artist',
  album: '',
  genre: 'House',
  comment: '',
  durationSec: 300,
  sampleRate: 44100,
  channels: 2,
  bpm: 128,
  key: '8A',
  grid: { anchors: [{ time: 0.5, bpm: 128 }], beatsPerBar: 4 },
  hotCues: [{ index: 0, time: 32, color: '#00a0e9', type: 'cue' }],
  memoryCues: [{ time: 64 }],
  cuePoint: 0.5,
  rating: 4,
  color: null,
  dateAdded: 1,
  analyzed: true,
  artwork: null
})

// Id namespaces
eq('a mirrored id is prefixed', C.rekordboxIdFor(KEY), 'rb-' + KEY)
eq('a local id is the bare audio key', C.localIdFor(KEY), KEY)
ok('mirrored ids are recognised', C.isRekordboxId(C.rekordboxIdFor(KEY)))
ok('local ids are not', !C.isRekordboxId(C.localIdFor(KEY)))
eq('the audio key is recoverable from a mirrored id', C.audioKeyFromId(C.rekordboxIdFor(KEY)), KEY)
eq('and from a local id', C.audioKeyFromId(C.localIdFor(KEY)), KEY)
eq('source is derivable from the id alone', C.sourceOfId(C.rekordboxIdFor(KEY)), 'rekordbox')
eq('local source', C.sourceOfId(KEY), 'local')

// Forking
{
  const m = mirrored()
  const f = C.forkToLocal(m)
  eq('a fork lands in the local namespace', f.id, KEY)
  eq('and is marked local', f.source, 'local')
  eq('and remembers where it came from', f.forkedFrom, C.rekordboxIdFor(KEY))
  eq('and keeps the audio key, so it inherits the waveform', f.audioKey, KEY)
  eq('and carries the grid over', f.grid.anchors[0].bpm, 128)
  eq('and the cues', f.hotCues[0].time, 32)
  eq('and the CUE point', f.cuePoint, 0.5)
}

// A fork must be a real copy: editing it cannot write through into the mirror.
{
  const m = mirrored()
  const f = C.forkToLocal(m)
  f.grid.anchors[0].time = 99
  f.hotCues[0].time = 99
  f.hotCues.push({ index: 1, time: 5, color: '#fff', type: 'cue' })
  f.memoryCues[0].time = 99
  eq('editing a fork does not move the mirror grid', m.grid.anchors[0].time, 0.5)
  eq('nor its hot cue', m.hotCues[0].time, 32)
  eq('nor add cues to it', m.hotCues.length, 1)
  eq('nor touch its memory cues', m.memoryCues[0].time, 64)
}

// resolveWrite: the path every edit goes through.
{
  const m = mirrored()
  const mirror = { [m.id]: m }
  const local = {}

  const first = C.resolveWrite(m.id, local, mirror)
  eq('editing a mirrored track targets the local id', first.id, KEY)
  ok('and hands back a fork to insert', first.fork !== null)
  eq('the fork is the record to insert', first.fork.id, KEY)

  // Simulate the store inserting it, then a second edit.
  local[first.fork.id] = { ...first.fork, rating: 1 }
  const second = C.resolveWrite(m.id, local, mirror)
  eq('a second edit reuses the existing fork', second.id, KEY)
  eq('and does not fork again', second.fork, null)
  eq('so the first edit survives', local[KEY].rating, 1)
}

{
  const m = mirrored()
  const local = { [KEY]: { ...m, id: KEY, source: 'local' } }
  const direct = C.resolveWrite(KEY, local, {})
  eq('editing a local track targets itself', direct.id, KEY)
  eq('with no fork', direct.fork, null)
}

eq('an unknown local id resolves to nothing', C.resolveWrite('nope', {}, {}), null)
eq('an unknown mirrored id resolves to nothing', C.resolveWrite('rb-nope', {}, {}), null)
