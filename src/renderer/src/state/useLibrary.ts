import { create } from 'zustand'
import type { LibraryFile, RekordboxSyncResult, Track, TrackSource } from '@shared/types'
import { mergeImported } from '@shared/rekordboxImport'
import { isRekordboxId, resolveWrite } from '@shared/collection'
import { LIBRARY_VERSION } from '@renderer/core/constants'

/**
 * The two collections.
 *
 * `tracks` is the local collection: the only thing that is ever written to
 * library.json, and the only place a record can be edited. `mirror` is a
 * read-only copy of the last rekordbox XML export, rebuilt wholesale on every
 * sync and never persisted, so it always says exactly what rekordbox said —
 * deletions included.
 *
 * Editing a mirrored record forks it into the local collection and the edit
 * lands on the fork, which is why `updateTrack` returns the id it actually
 * wrote to. Callers holding the old id — a deck, a selection — must adopt it,
 * or their next edit forks again from the mirror and the first one is stranded
 * on a record nothing references.
 *
 * Writes to disk are debounced because a single grid nudge or hot cue drag
 * rewrites the whole file.
 */
/**
 * What a one-shot XML import did, so the browser can report it rather than
 * guess. Distinct from a sync: an import copies the export into the local
 * collection once, where a sync only rebuilds the read-only mirror.
 */
export interface RekordboxImportSummary {
  cancelled: boolean
  /** Tracks that were not already in the collection. */
  added: number
  /** Tracks already present, refreshed in place. */
  updated: number
  /** Referenced files that are not on this machine right now. */
  missing: number
  /** Playlists found in the export. Not shown yet, but carried through. */
  playlists: number
  producedBy: string
}

/** Status of the rekordbox mirror, for the "synced from" readout. */
export interface RekordboxMirrorMeta {
  /** The remembered XML export, or null when none has been chosen. */
  xmlPath: string | null
  /** When the mirror was last rebuilt. 0 before the first sync. */
  syncedAt: number
  /** The rekordbox version that wrote the XML, when it says. */
  producedBy: string
  /** Referenced files that are not on this machine right now. */
  missing: number
  /** Playlists found in the export. */
  playlists: number
  /** Set when the last sync attempt failed, e.g. the file has been moved. */
  error?: string
}

/** Which collection the browser is showing. */
export type CollectionScope = 'collection' | 'rekordbox'

export interface LibraryState {
  /** The local collection. Persisted to library.json, and nothing else is. */
  tracks: Record<string, Track>
  /** Import order. `visibleTracks()` applies search and sort on top of it. */
  order: string[]
  /** The rekordbox mirror, keyed by mirrored id. Never persisted. */
  mirror: Record<string, Track>
  /** Mirror display order, as the XML listed it. */
  mirrorOrder: string[]
  mirrorMeta: RekordboxMirrorMeta
  scope: CollectionScope
  search: string
  sortBy: keyof Track
  sortDir: 'asc' | 'desc'
  selectedId: string | null
  /** Replace the in-memory local collection with what is on disk. */
  loadFromDisk(): Promise<void>
  /** Native open dialog -> tag read -> add to the local collection. */
  importFiles(): Promise<void>
  /** Copy a rekordbox XML export into the local collection, once. */
  importRekordbox(): Promise<RekordboxImportSummary>
  /** Pick and remember an XML export, then mirror it. */
  chooseRekordboxXml(): Promise<void>
  /** Re-read the remembered XML now. */
  syncRekordbox(): Promise<void>
  /** Forget the remembered path and drop the mirror. */
  clearRekordboxXml(): Promise<void>
  /** Replace the mirror with a sync result. Also the push handler. */
  applyRekordboxSync(result: RekordboxSyncResult): void
  /** Adds new tracks; ids already present are refreshed, never duplicated. */
  addTracks(tracks: Track[]): void
  /**
   * Apply a patch, forking a mirrored record into the local collection first.
   * Returns the id the patch landed on, or null when there was nothing to
   * write to. Callers must adopt the returned id.
   */
  updateTrack(id: string, patch: Partial<Track>): string | null
  removeTrack(id: string): void
  /** Look a record up in either collection, local first. */
  trackById(id: string): Track | undefined
  setSearch(q: string): void
  setScope(scope: CollectionScope): void
  /** Sort by a column, flipping direction when it is already the sort column. */
  setSort(by: keyof Track): void
  select(id: string | null): void
  /** The tracks of the current scope, with search and sort applied. */
  visibleTracks(): Track[]
}

const SAVE_DEBOUNCE_MS = 400

const EMPTY_MIRROR_META: RekordboxMirrorMeta = {
  xmlPath: null,
  syncedAt: 0,
  producedBy: '',
  missing: 0,
  playlists: 0
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
/** True while `loadFromDisk` is writing, so hydration does not echo back out. */
let hydrating = false
/** Set when the store has moved on from what main was last handed. */
let dirty = false
/** The running write loop, or null when no write is in flight. */
let saveRun: Promise<void> | null = null

/**
 * The local collection exactly as it stands now, in the on-disk shape.
 *
 * Mirrored records are filtered out here rather than at the call sites: the
 * mirror is derived from the XML and rebuilt on every sync, so persisting one
 * would resurrect a track rekordbox has since deleted, and it would come back
 * as a local record that no sync can ever clean up.
 */
function snapshotLibrary(): LibraryFile {
  const { tracks, order, mirrorMeta } = useLibrary.getState()
  const lib: LibraryFile = {
    version: LIBRARY_VERSION,
    tracks: order
      .map((id) => tracks[id])
      .filter((t): t is Track => t != null && t.source === 'local' && !isRekordboxId(t.id))
  }
  // Main remembers the watched path itself; echoing it back only ever
  // preserves it, and never clears it with a mirror that has not synced yet.
  if (mirrorMeta.xmlPath) lib.rekordboxXmlPath = mirrorMeta.xmlPath
  return lib
}

/**
 * Write pending changes one at a time.
 *
 * Overlapping saves can be applied by main in the opposite order to the calls
 * that started them, which persists a stale snapshot over a newer one. Only one
 * write is ever in flight, and each pass snapshots the store as it starts, so
 * whatever changed while the previous write was running is covered by the next
 * one instead of being written from a stale capture.
 */
async function drainSaves(): Promise<void> {
  while (dirty) {
    dirty = false
    try {
      await window.api.saveLibrary(snapshotLibrary())
    } catch (err) {
      console.error('[library] save failed', err)
    }
  }
  saveRun = null
}

function scheduleSave(): void {
  if (hydrating) return
  dirty = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!saveRun) saveRun = drainSaves()
  }, SAVE_DEBOUNCE_MS)
}

/**
 * Write any pending change immediately.
 *
 * Teardown cannot await anything, so the invoke is issued directly rather than
 * queued behind `drainSaves`: a queued save would be waiting on a promise the
 * closing page never lets resolve, and the edit would be lost. `invoke` posts
 * its message synchronously, so the payload is on its way to main even though
 * the promise it returns never settles here. Main serialises library writes and
 * holds the quit open until they land, so this last snapshot still wins over a
 * write that was already in flight.
 */
export function flushLibrarySave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!dirty) return saveRun ?? Promise.resolve()
  dirty = false
  return window.api.saveLibrary(snapshotLibrary()).catch((err) => {
    console.error('[library] save failed', err)
  })
}

/**
 * library.json is a plain file a user can edit or carry between versions, so
 * fill in anything missing rather than letting `undefined` reach the UI.
 *
 * `source` and `audioKey` are backfilled because records written before the
 * two-collection split have neither, and every write now resolves through
 * them: without the backfill an existing library would load as records that
 * cannot be edited and whose waveform cache cannot be found.
 */
function normalizeTrack(t: Track, source?: TrackSource): Track {
  return {
    ...t,
    source: source ?? t.source ?? 'local',
    // Pre-split ids were the path hash under another name, so the id is the
    // right value to fall back to and keeps the cache entry findable.
    audioKey: t.audioKey ?? t.id,
    bpm: t.bpm ?? null,
    key: t.key ?? null,
    grid: t.grid ?? null,
    hotCues: Array.isArray(t.hotCues) ? t.hotCues : [],
    memoryCues: Array.isArray(t.memoryCues) ? t.memoryCues : [],
    cuePoint: t.cuePoint ?? null,
    rating: t.rating ?? 0,
    color: t.color ?? null,
    analyzed: t.analyzed === true,
    artwork: t.artwork ?? null
  }
}

/**
 * Sortable projection of a column. Anything unsortable — a grid, a cue list —
 * and anything empty reads as null so it can be pushed to the bottom.
 */
function sortValue(track: Track, key: keyof Track): string | number | null {
  const v = track[key]
  if (v == null) return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') return v.length > 0 ? v : null
  return null
}

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true })
}

/**
 * Search and sort, shared by both collections so the browser behaves the same
 * whichever scope it is showing.
 */
function applyView(rows: Track[], search: string, sortBy: keyof Track, sortDir: 'asc' | 'desc'): Track[] {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  let out = rows
  if (terms.length > 0) {
    out = out.filter((t) => {
      const hay = `${t.title} ${t.artist} ${t.album} ${t.genre}`.toLowerCase()
      return terms.every((term) => hay.includes(term))
    })
  }

  const dir = sortDir === 'asc' ? 1 : -1
  return [...out].sort((a, b) => {
    const av = sortValue(a, sortBy)
    const bv = sortValue(b, sortBy)
    // Unanalysed and untagged tracks sink to the bottom either way round,
    // so flipping a BPM sort never floats a track with no BPM to the top.
    if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1
    return dir * compareValues(av, bv)
  })
}

export const useLibrary = create<LibraryState>()((set, get) => ({
  tracks: {},
  order: [],
  mirror: {},
  mirrorOrder: [],
  mirrorMeta: EMPTY_MIRROR_META,
  scope: 'collection',
  search: '',
  sortBy: 'dateAdded',
  sortDir: 'desc',
  selectedId: null,

  async loadFromDisk() {
    const lib = await window.api.loadLibrary()
    const tracks: Record<string, Track> = {}
    const order: string[] = []
    for (const t of lib?.tracks ?? []) {
      if (!t?.id || tracks[t.id]) continue
      // A mirrored record has no business in library.json. Dropping it loses
      // nothing — the next sync rebuilds the mirror from the XML — whereas
      // loading it would put a record the user cannot own into the collection.
      if (isRekordboxId(t.id) || t.source === 'rekordbox') continue
      tracks[t.id] = normalizeTrack(t, 'local')
      order.push(t.id)
    }
    hydrating = true
    try {
      set({
        tracks,
        order,
        // Carry the remembered path through so the UI can name the export
        // before the first sync of this session lands.
        mirrorMeta: { ...get().mirrorMeta, xmlPath: lib?.rekordboxXmlPath ?? null }
      })
    } finally {
      hydrating = false
    }
  },

  async importFiles() {
    const paths = await window.api.openAudioFiles()
    if (!paths.length) return
    const imported = await window.api.importPaths(paths)
    if (!imported.length) return
    get().addTracks(imported.map((t) => normalizeTrack(t, 'local')))
  },

  async importRekordbox() {
    const result = await window.api.importRekordboxXml()
    if (!result.xmlPath) {
      return { cancelled: true, added: 0, updated: 0, missing: 0, playlists: 0, producedBy: '' }
    }
    // Count against the collection as it stands before the merge, so "added"
    // and "updated" mean what they say.
    const before = get().tracks
    let added = 0
    let updated = 0
    for (const t of result.tracks) {
      if (before[t.id]) updated++
      else added++
    }
    get().addTracks(result.tracks.map((t) => normalizeTrack(t, 'local')))
    return {
      cancelled: false,
      added,
      updated,
      missing: result.missingPaths.length,
      playlists: result.playlists.length,
      producedBy: result.producedBy
    }
  },

  async chooseRekordboxXml() {
    try {
      const result = await window.api.chooseRekordboxXml()
      // A cancelled dialog reports no path and no error. Applying that would
      // clear a mirror the user never asked to clear.
      if (!result.xmlPath && !result.error) return
      get().applyRekordboxSync(result)
    } catch (err) {
      console.error('[library] rekordbox choose failed', err)
      set((s) => ({ mirrorMeta: { ...s.mirrorMeta, error: String(err) } }))
    }
  },

  async syncRekordbox() {
    try {
      get().applyRekordboxSync(await window.api.syncRekordbox())
    } catch (err) {
      console.error('[library] rekordbox sync failed', err)
      set((s) => ({ mirrorMeta: { ...s.mirrorMeta, error: String(err) } }))
    }
  },

  async clearRekordboxXml() {
    try {
      await window.api.clearRekordboxXml()
    } catch (err) {
      console.error('[library] rekordbox clear failed', err)
    }
    set((s) => ({
      mirror: {},
      mirrorOrder: [],
      mirrorMeta: EMPTY_MIRROR_META,
      // Nothing left to show in that scope, so do not strand the browser in it.
      scope: s.scope === 'rekordbox' ? 'collection' : s.scope
    }))
  },

  applyRekordboxSync(result) {
    if (!result) return
    const meta: RekordboxMirrorMeta = {
      xmlPath: result.xmlPath ?? null,
      syncedAt: result.syncedAt ?? Date.now(),
      producedBy: result.producedBy ?? '',
      missing: result.missingPaths?.length ?? 0,
      playlists: result.playlists?.length ?? 0,
      ...(result.error ? { error: result.error } : {})
    }

    // A failed read is not rekordbox saying the collection is empty — the file
    // is typically mid-rewrite by an export that is still running. Keep the
    // last good mirror and report the error instead of blanking the browser.
    if (result.error && (result.tracks?.length ?? 0) === 0) {
      set((s) => ({ mirrorMeta: { ...meta, xmlPath: meta.xmlPath ?? s.mirrorMeta.xmlPath } }))
      return
    }

    const mirror: Record<string, Track> = {}
    const mirrorOrder: string[] = []
    for (const t of result.tracks ?? []) {
      if (!t?.id || mirror[t.id]) continue
      // Forced rather than trusted: a record that reads as local in here would
      // be editable in place and could reach library.json.
      mirror[t.id] = normalizeTrack(t, 'rekordbox')
      mirrorOrder.push(t.id)
    }
    // Wholesale replacement is the point: a track deleted in rekordbox has to
    // disappear here too, which merging could never achieve.
    set({ mirror, mirrorOrder, mirrorMeta: meta })
  },

  addTracks(incoming) {
    if (!incoming.length) return
    set((s) => {
      const tracks = { ...s.tracks }
      const order = [...s.order]
      for (const t of incoming) {
        // Mirrored records only enter the local collection through a fork.
        if (!t?.id || isRekordboxId(t.id)) continue
        const existing = tracks[t.id]
        if (existing) {
          tracks[t.id] = mergeImported(existing, t)
        } else {
          tracks[t.id] = t
          order.push(t.id)
        }
      }
      return { tracks, order }
    })
  },

  updateTrack(id, patch) {
    const target = resolveWrite(id, get().tracks, get().mirror)
    if (!target) return null
    set((s) => {
      const tracks = { ...s.tracks }
      const order = target.fork ? [...s.order, target.fork.id] : s.order
      if (target.fork) tracks[target.fork.id] = target.fork
      const existing = tracks[target.id]
      if (!existing) return s
      // `order` is keyed by id, and the collection a record belongs to is not
      // the caller's to change, so a patch must never move any of the three.
      tracks[target.id] = {
        ...existing,
        ...patch,
        id: existing.id,
        source: existing.source,
        audioKey: existing.audioKey
      }
      return { tracks, order }
    })
    return target.id
  },

  removeTrack(id) {
    set((s) => {
      // Mirrored records are not the user's to delete; they leave when
      // rekordbox stops listing them.
      if (!s.tracks[id]) return s
      const tracks = { ...s.tracks }
      delete tracks[id]
      return {
        tracks,
        order: s.order.filter((x) => x !== id),
        selectedId: s.selectedId === id ? null : s.selectedId
      }
    })
  },

  trackById(id) {
    const s = get()
    return s.tracks[id] ?? s.mirror[id]
  },

  setSearch(q) {
    set({ search: q })
  },

  setScope(scope) {
    set({ scope })
  },

  setSort(by) {
    set((s) => (s.sortBy === by ? { sortDir: s.sortDir === 'asc' ? 'desc' : 'asc' } : { sortBy: by, sortDir: 'asc' }))
  },

  select(id) {
    set({ selectedId: id })
  },

  visibleTracks() {
    const { tracks, order, mirror, mirrorOrder, scope, search, sortBy, sortDir } = get()
    const records = scope === 'rekordbox' ? mirror : tracks
    const ids = scope === 'rekordbox' ? mirrorOrder : order
    const rows = ids.map((id) => records[id]).filter((t): t is Track => t != null)
    return applyView(rows, search, sortBy, sortDir)
  }
}))

useLibrary.subscribe((state, prev) => {
  // The mirror is derived, so only the local collection is worth a write.
  if (state.tracks !== prev.tracks || state.order !== prev.order) scheduleSave()
})

if (typeof window !== 'undefined') {
  // Main watches the XML and pushes a fresh mirror when it changes. Subscribing
  // at module scope rather than from a component means a sync that lands during
  // startup is not missed, and there is only ever one registration.
  window.api?.onRekordboxSync?.((result) => {
    useLibrary.getState().applyRekordboxSync(result)
  })

  // A debounced hot cue or grid edit would otherwise die with the page. The
  // flush is a no-op when nothing is pending, and main will not let the process
  // go until the write it posts has reached disk.
  window.addEventListener('beforeunload', () => {
    void flushLibrarySave()
  })
}
