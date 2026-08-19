/**
 * The library store's half of the two-collection model.
 *
 * `collection.test.mjs` covers the pure fork maths; this covers what the store
 * does with it: that an edit to a mirrored track lands on a fork and reports
 * the id it landed on, that a sync replaces the mirror rather than merging into
 * it, that search and sort behave the same in both scopes, and above all that
 * nothing mirrored can ever reach library.json.
 *
 * The store is bundled here rather than by `run.mjs` because it needs the
 * `@shared` and `@renderer` path aliases resolved, and because it must be
 * imported only after `window` is stubbed. No DOM is involved: the store reads
 * `window.api` and adds one `beforeunload` listener, and stubs for those two
 * are enough to exercise every code path in this file.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const { eq, ok } = globalThis.__t

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outFile = join(here, '.build', 'useLibrary.mjs')

mkdirSync(join(here, '.build'), { recursive: true })
execFileSync(
  join(root, 'node_modules/.bin/esbuild'),
  [
    join(root, 'src/renderer/src/state/useLibrary.ts'),
    '--bundle',
    '--format=esm',
    '--platform=neutral',
    `--alias:@shared=${join(root, 'src/shared')}`,
    `--alias:@renderer=${join(root, 'src/renderer/src')}`,
    `--outfile=${outFile}`
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] }
)

/** Everything the store touches outside itself, recorded so it can be asserted on. */
const saved = []
let onSync = null
globalThis.window = {
  api: {
    saveLibrary: async (lib) => {
      saved.push(lib)
    },
    onRekordboxSync: (cb) => {
      onSync = cb
      return () => {}
    }
  },
  addEventListener: () => {}
}

const { useLibrary, flushLibrarySave } = await import(pathToFileURL(outFile).href)

const KEY_A = 'a'.repeat(40)
const KEY_B = 'b'.repeat(40)

function track(over) {
  return {
    id: KEY_A,
    source: 'local',
    audioKey: KEY_A,
    path: '/Music/a.mp3',
    title: 'Alpha',
    artist: 'Artist A',
    album: '',
    genre: 'House',
    comment: '',
    durationSec: 300,
    sampleRate: 44100,
    channels: 2,
    bpm: 128,
    key: '8A',
    grid: null,
    hotCues: [],
    memoryCues: [],
    cuePoint: null,
    rating: 0,
    color: null,
    dateAdded: 1,
    analyzed: false,
    artwork: null,
    ...over
  }
}

const mirrored = (over) =>
  track({ id: `rb-${KEY_A}`, source: 'rekordbox', audioKey: KEY_A, ...over })

function syncResult(tracks, over) {
  return {
    xmlPath: '/Users/x/rekordbox.xml',
    producedBy: 'rekordbox 6.8.5',
    tracks,
    missingPaths: ['/gone.mp3'],
    playlists: [{ name: 'Set', folders: [], trackIds: [] }],
    syncedAt: 1000,
    ...over
  }
}

/** Back to an empty store, with any save the reset itself provoked drained. */
async function reset() {
  useLibrary.setState({
    tracks: {},
    order: [],
    mirror: {},
    mirrorOrder: [],
    mirrorMeta: { xmlPath: null, syncedAt: 0, producedBy: '', missing: 0, playlists: 0 },
    scope: 'collection',
    search: '',
    sortBy: 'dateAdded',
    sortDir: 'desc',
    selectedId: null
  })
  await flushLibrarySave()
  saved.length = 0
}

// --- migration -------------------------------------------------------------

await reset()
{
  // A record written before the split: no source, no audioKey.
  const old = track({})
  delete old.source
  delete old.audioKey
  delete old.hotCues
  window.api.loadLibrary = async () => ({ version: 1, tracks: [old], rekordboxXmlPath: '/x.xml' })
  await useLibrary.getState().loadFromDisk()
  const loaded = useLibrary.getState().tracks[KEY_A]
  ok('migration: an old record still loads', loaded != null)
  eq('migration: source backfilled', loaded.source, 'local')
  eq('migration: audioKey falls back to the id', loaded.audioKey, KEY_A)
  ok('migration: hotCues backfilled', Array.isArray(loaded.hotCues))
  eq('migration: remembered xml path kept', useLibrary.getState().mirrorMeta.xmlPath, '/x.xml')
}

await reset()
{
  // A mirrored record in library.json is a bug from some other version; it must
  // not come back as an editable local track.
  window.api.loadLibrary = async () => ({ version: 1, tracks: [mirrored()] })
  await useLibrary.getState().loadFromDisk()
  eq('migration: mirrored records are not loaded', useLibrary.getState().order.length, 0)
}

// --- the mirror ------------------------------------------------------------

await reset()
{
  const s = useLibrary.getState()
  s.applyRekordboxSync(syncResult([mirrored(), mirrored({ id: `rb-${KEY_B}`, audioKey: KEY_B })]))
  eq('sync: mirror populated', useLibrary.getState().mirrorOrder.length, 2)
  eq('sync: nothing local', useLibrary.getState().order.length, 0)
  eq('sync: source forced', useLibrary.getState().mirror[`rb-${KEY_A}`].source, 'rekordbox')
  eq('sync: missing counted', useLibrary.getState().mirrorMeta.missing, 1)
  eq('sync: playlists counted', useLibrary.getState().mirrorMeta.playlists, 1)

  // A track dropped in rekordbox has to disappear here, which is why the
  // mirror is replaced rather than merged.
  s.applyRekordboxSync(syncResult([mirrored()]))
  eq('sync: replaced wholesale', useLibrary.getState().mirrorOrder.length, 1)
  ok('sync: deletion propagated', useLibrary.getState().mirror[`rb-${KEY_B}`] === undefined)

  // A failed read is not rekordbox saying the collection is empty.
  s.applyRekordboxSync(syncResult([], { error: 'ENOENT' }))
  eq('sync: a failed read keeps the last good mirror', useLibrary.getState().mirrorOrder.length, 1)
  eq('sync: the error is reported', useLibrary.getState().mirrorMeta.error, 'ENOENT')
}

await reset()
{
  ok('sync: the push subscription is registered at startup', typeof onSync === 'function')
  onSync(syncResult([mirrored()]))
  eq('sync: a pushed result is applied', useLibrary.getState().mirrorOrder.length, 1)
}

// --- copy on write ---------------------------------------------------------

await reset()
{
  const s = useLibrary.getState()
  s.applyRekordboxSync(syncResult([mirrored({ rating: 3 })]))

  const rbId = `rb-${KEY_A}`
  const written = s.updateTrack(rbId, { rating: 5 })
  eq('write: the fork id is returned', written, KEY_A)
  eq('write: the edit landed on the fork', useLibrary.getState().tracks[KEY_A].rating, 5)
  eq('write: the mirror is untouched', useLibrary.getState().mirror[rbId].rating, 3)
  eq('write: the fork is in the local order', useLibrary.getState().order.length, 1)
  eq('write: the fork remembers its origin', useLibrary.getState().tracks[KEY_A].forkedFrom, rbId)
  eq('write: the fork keeps the audio key', useLibrary.getState().tracks[KEY_A].audioKey, KEY_A)

  // The second edit must find the existing fork, not build a fresh one from
  // the mirror, or the first edit would be silently undone.
  const again = s.updateTrack(rbId, { cuePoint: 4 })
  eq('write: the second edit reuses the fork', again, KEY_A)
  eq('write: the first edit survives', useLibrary.getState().tracks[KEY_A].rating, 5)
  eq('write: no duplicate row', useLibrary.getState().order.length, 1)

  eq('write: an unknown id writes nothing', s.updateTrack('nope', { rating: 1 }), null)

  // Identity is the store's, not the caller's.
  s.updateTrack(KEY_A, { id: 'hacked', source: 'rekordbox', audioKey: 'other' })
  const fork = useLibrary.getState().tracks[KEY_A]
  eq('write: the id is pinned', fork.id, KEY_A)
  eq('write: the source is pinned', fork.source, 'local')
  eq('write: the audio key is pinned', fork.audioKey, KEY_A)
}

// --- persistence -----------------------------------------------------------

await reset()
{
  const s = useLibrary.getState()
  s.applyRekordboxSync(syncResult([mirrored()]))
  s.addTracks([track({ id: KEY_B, audioKey: KEY_B, title: 'Beta' })])
  s.updateTrack(`rb-${KEY_A}`, { rating: 4 })
  // Belt and braces: even if a mirrored record were forced into the local map,
  // the save must not carry it to disk.
  useLibrary.setState((st) => ({
    tracks: { ...st.tracks, [`rb-${KEY_B}`]: mirrored({ id: `rb-${KEY_B}`, audioKey: KEY_B }) },
    order: [...st.order, `rb-${KEY_B}`]
  }))
  await flushLibrarySave()

  const lib = saved[saved.length - 1]
  ok('save: something was written', lib != null)
  ok('save: no mirrored record reaches disk', lib.tracks.every((t) => t.source === 'local' && !t.id.startsWith('rb-')))
  eq('save: the fork and the local track are written', lib.tracks.length, 2)
  eq('save: the xml path is carried through', lib.rekordboxXmlPath, '/Users/x/rekordbox.xml')
}

await reset()
{
  // The mirror is derived, so rebuilding it is not a reason to rewrite the file.
  useLibrary.getState().applyRekordboxSync(syncResult([mirrored()]))
  await flushLibrarySave()
  eq('save: a sync alone writes nothing', saved.length, 0)
}

// --- lookups and scope -----------------------------------------------------

await reset()
{
  const s = useLibrary.getState()
  s.applyRekordboxSync(syncResult([mirrored({ title: 'Mirrored' })]))
  s.addTracks([track({ title: 'Local' })])
  eq('lookup: local wins', s.trackById(KEY_A).title, 'Local')
  eq('lookup: the mirror is searched too', s.trackById(`rb-${KEY_A}`).title, 'Mirrored')
  eq('lookup: unknown ids resolve to nothing', s.trackById('nope'), undefined)
}

await reset()
{
  const s = useLibrary.getState()
  s.addTracks([
    track({ id: KEY_A, audioKey: KEY_A, title: 'Zulu', artist: 'Kraftwerk', bpm: 120 }),
    track({ id: KEY_B, audioKey: KEY_B, title: 'Alpha', artist: 'Underworld', bpm: 140 })
  ])
  s.applyRekordboxSync(
    syncResult([
      mirrored({ id: `rb-${KEY_A}`, audioKey: KEY_A, title: 'Zulu', artist: 'Kraftwerk', bpm: 120 }),
      mirrored({ id: `rb-${KEY_B}`, audioKey: KEY_B, title: 'Alpha', artist: 'Underworld', bpm: 140 })
    ])
  )

  eq('scope: collection by default', useLibrary.getState().scope, 'collection')
  useLibrary.setState({ sortBy: 'title', sortDir: 'asc' })
  const localTitles = s.visibleTracks().map((t) => t.title)
  s.setScope('rekordbox')
  const mirrorTitles = useLibrary.getState().visibleTracks().map((t) => t.title)
  eq('scope: sorting is identical in both', mirrorTitles.join(), localTitles.join())
  eq('scope: sorted by title', mirrorTitles.join(), 'Alpha,Zulu')
  const rbRows = useLibrary.getState().visibleTracks()
  ok('scope: rekordbox rows come from the mirror', rbRows.every((t) => t.source === 'rekordbox'))

  useLibrary.setState({ search: 'kraft' })
  eq('scope: search applies to the mirror', useLibrary.getState().visibleTracks().length, 1)
  s.setScope('collection')
  eq('scope: search applies the same locally', useLibrary.getState().visibleTracks().length, 1)
  eq('scope: the same track matches', useLibrary.getState().visibleTracks()[0].artist, 'Kraftwerk')
}

await reset()
{
  const s = useLibrary.getState()
  s.applyRekordboxSync(syncResult([mirrored()]))
  s.setScope('rekordbox')
  window.api.clearRekordboxXml = async () => {}
  await s.clearRekordboxXml()
  eq('clear: the mirror is dropped', useLibrary.getState().mirrorOrder.length, 0)
  eq('clear: the path is forgotten', useLibrary.getState().mirrorMeta.xmlPath, null)
  eq('clear: the browser leaves the empty scope', useLibrary.getState().scope, 'collection')
}

await reset()
{
  // A cancelled dialog reports no path; applying it would clear the mirror.
  const s = useLibrary.getState()
  s.applyRekordboxSync(syncResult([mirrored()]))
  window.api.chooseRekordboxXml = async () => ({
    xmlPath: null,
    producedBy: '',
    tracks: [],
    missingPaths: [],
    playlists: [],
    syncedAt: 0
  })
  await s.chooseRekordboxXml()
  eq('choose: a cancelled dialog changes nothing', useLibrary.getState().mirrorOrder.length, 1)
}

await reset()
await flushLibrarySave()
