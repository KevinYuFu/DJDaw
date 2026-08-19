import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, ReactElement } from 'react'
import type { Track } from '@shared/types'
import { useLibrary } from '@renderer/state/useLibrary'
import { TreeSidebar } from './TreeSidebar'
import { TrackTable } from './TrackTable'
import './browser.css'

/**
 * The bottom half of the window: source tree, track table, and the header bar
 * that searches, sorts and imports into them.
 *
 * The header names the collection on screen because the two behave differently
 * — one is yours, the other is a mirror that forks when edited — and a count
 * with no collection beside it says nothing about which one changed.
 */

interface SortOption {
  key: keyof Track
  label: string
}

/** Mirrors the sortable columns of the table, in the same order. */
const SORT_OPTIONS: readonly SortOption[] = [
  { key: 'title', label: 'Title' },
  { key: 'artist', label: 'Artist' },
  { key: 'bpm', label: 'BPM' },
  { key: 'key', label: 'Key' },
  { key: 'rating', label: 'Rating' },
  { key: 'durationSec', label: 'Time' },
  { key: 'genre', label: 'Genre' },
  { key: 'dateAdded', label: 'Date Added' }
]

/** Mirrors the import dialog's filter in `main/ipc.ts`. */
const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'wav',
  'flac',
  'm4a',
  'aac',
  'aiff',
  'aif',
  'ogg',
  'opus',
  'wma'
])

/** How long a notice stays up before it fades out of the way. */
const NOTICE_MS = 7000

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

function isAudioPath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot > 0 && AUDIO_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}

/**
 * Absolute path of a dropped file, or null when this build cannot see one.
 *
 * Electron 32 removed `File.path`, and its replacement `webUtils.getPathForFile`
 * exists only in the preload realm — the `window.api` bridge does not re-export
 * it, so on Electron 43 there is genuinely nothing here to read. The lookup
 * stays because it costs nothing and it is exactly what a preload-side
 * `pathForFile` would feed, but until the bridge grows one, a Finder drop
 * cannot be resolved and the user is told to use the Import button instead of
 * being left with a drop target that silently swallows files.
 */
function fileSystemPath(file: File): string | null {
  const legacy: unknown = (file as File & { path?: unknown }).path
  return typeof legacy === 'string' && legacy.length > 0 ? legacy : null
}

function hasFiles(transfer: DataTransfer | null): boolean {
  return transfer != null && Array.from(transfer.types).includes('Files')
}

export function Browser(): ReactElement {
  const tracks = useLibrary((s) => s.tracks)
  const order = useLibrary((s) => s.order)
  const mirror = useLibrary((s) => s.mirror)
  const mirrorOrder = useLibrary((s) => s.mirrorOrder)
  const mirrorMeta = useLibrary((s) => s.mirrorMeta)
  const scope = useLibrary((s) => s.scope)
  const setScope = useLibrary((s) => s.setScope)
  const syncRekordbox = useLibrary((s) => s.syncRekordbox)
  const search = useLibrary((s) => s.search)
  const sortBy = useLibrary((s) => s.sortBy)
  const sortDir = useLibrary((s) => s.sortDir)
  const setSearch = useLibrary((s) => s.setSearch)
  const setSort = useLibrary((s) => s.setSort)
  const addTracks = useLibrary((s) => s.addTracks)
  const importFiles = useLibrary((s) => s.importFiles)

  const [importing, setImporting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // dragenter/dragleave fire for every child element, so the target only stops
  // being "hovered" once as many leaves as enters have come back.
  const dragDepth = useRef(0)

  const notify = useCallback((message: string): void => {
    setNotice(message)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null
      setNotice(null)
    }, NOTICE_MS)
  }, [])

  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    }
  }, [])

  /** Total rows in the collection on screen, before the search narrows them. */
  const scopeCount = scope === 'rekordbox' ? mirrorOrder.length : order.length
  const scopeLabel = scope === 'rekordbox' ? 'rekordbox' : 'Collection'

  // The count is search-dependent but sort-independent, so it does not need to
  // recompute when the sort column changes.
  const matchCount = useMemo(
    () => (search.trim() === '' ? scopeCount : useLibrary.getState().visibleTracks().length),
    [tracks, order, mirror, mirrorOrder, scope, scopeCount, search]
  )

  // Announce a sync when it lands: it can arrive unprompted, because main
  // re-reads the XML whenever rekordbox rewrites it, and a collection changing
  // size on its own needs a reason on screen. Keyed on the stamp rather than
  // the object so a re-render cannot re-announce the same sync, and seeded on
  // the first pass so a remount does not announce one that already happened.
  const announced = useRef<string | null>(null)
  useEffect(() => {
    const stamp = `${mirrorMeta.syncedAt}:${mirrorMeta.error ?? ''}`
    if (announced.current === null) {
      announced.current = stamp
      return
    }
    if (stamp === announced.current) return
    announced.current = stamp
    if (mirrorMeta.error) {
      notify(`rekordbox sync failed: ${mirrorMeta.error}`)
      return
    }
    if (!mirrorMeta.xmlPath) return
    const missing = mirrorMeta.missing
    const parts = [`${mirrorOrder.length} track${mirrorOrder.length === 1 ? '' : 's'}`]
    if (missing) parts.push(`${missing} file${missing === 1 ? '' : 's'} not found`)
    notify(`rekordbox synced: ${parts.join(', ')}`)
  }, [mirrorMeta, mirrorOrder, notify])

  const onImport = useCallback(async (): Promise<void> => {
    setImporting(true)
    try {
      await importFiles()
    } catch (err) {
      console.error('[browser] import failed', err)
      notify(`Import failed: ${messageOf(err)}`)
    } finally {
      setImporting(false)
    }
  }, [importFiles, notify])

  /**
   * The one-shot XML import, which is a different thing from the mirror: it
   * copies the export into the local collection once, and nothing links the two
   * afterwards. Kept alongside the mirror because an import is what you want
   * when the collection is moving to DJDaw for good.
   */
  const onImportRekordbox = useCallback(async (): Promise<void> => {
    setImporting(true)
    try {
      const result = await window.api.importRekordboxXml()
      if (!result.xmlPath) return
      // Counted against the collection as it stands before the merge, so
      // "added" and "refreshed" mean what they say.
      const before = useLibrary.getState().tracks
      let added = 0
      let updated = 0
      for (const track of result.tracks) {
        if (before[track.id]) updated++
        else added++
      }
      addTracks(result.tracks)
      // The import lands in the local collection, so show it: leaving the
      // browser on the mirror would look like the import did nothing.
      setScope('collection')

      const parts = [`${added} added`]
      if (updated) parts.push(`${updated} refreshed`)
      // Say so loudly: a collection on an unmounted drive imports as rows that
      // cannot be played, and silently reporting success would be misleading.
      const missing = result.missingPaths.length
      if (missing) parts.push(`${missing} file${missing === 1 ? '' : 's'} not found`)
      if (result.playlists.length) parts.push(`${result.playlists.length} playlists ignored for now`)
      notify(`rekordbox import: ${parts.join(', ')}`)
    } catch (err) {
      console.error('[browser] rekordbox import failed', err)
      notify(`rekordbox import failed: ${messageOf(err)}`)
    } finally {
      setImporting(false)
    }
  }, [addTracks, notify, setScope])

  const onDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }, [])

  const onDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasFiles(event.dataTransfer)) return
    // Without this the drop never fires and the window navigates to the file.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasFiles(event.dataTransfer)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }, [])

  const onDrop = useCallback(
    async (event: ReactDragEvent<HTMLDivElement>): Promise<void> => {
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)

      // dataTransfer is emptied once the handler yields, so read it up front.
      const files = Array.from(event.dataTransfer.files)
      if (files.length === 0) return

      const paths = files.map(fileSystemPath).filter((p): p is string => p != null)
      if (paths.length === 0) {
        notify(
          'Dropped files cannot be resolved to paths in this Electron version. ' +
            'Use + IMPORT TRACKS to add them.'
        )
        return
      }

      const audio = paths.filter(isAudioPath)
      if (audio.length === 0) {
        notify('Nothing there to import — folders are not scanned yet, only audio files.')
        return
      }

      try {
        const imported = await window.api.importPaths(audio)
        if (imported.length === 0) {
          notify('None of those files could be read.')
          return
        }
        addTracks(imported)
        notify(`Imported ${imported.length} track${imported.length === 1 ? '' : 's'}.`)
      } catch (err) {
        console.error('[browser] drop import failed', err)
        notify(`Import failed: ${messageOf(err)}`)
      }
    },
    [addTracks, notify]
  )

  return (
    <div
      className="browser"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(event) => void onDrop(event)}
    >
      <div className="browser-header">
        <div className="browser-search">
          <span className="browser-search-icon" aria-hidden="true">
            <svg width="11" height="11" viewBox="0 0 11 11">
              <circle cx="4.5" cy="4.5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <path d="M7.2 7.2 L10.2 10.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </span>
          <input
            type="text"
            value={search}
            placeholder="Search title, artist, album, genre"
            aria-label="Search the collection"
            onChange={(event) => setSearch(event.target.value)}
          />
          {search !== '' && (
            <button
              type="button"
              className="browser-search-clear"
              title="Clear search"
              aria-label="Clear search"
              onClick={() => setSearch('')}
            >
              <svg width="8" height="8" viewBox="0 0 8 8">
                <path d="M1 1 L7 7 M7 1 L1 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>

        <div
          className="browser-scope"
          title={
            scope === 'rekordbox'
              ? 'Viewing the read-only rekordbox mirror. Editing a track here copies it into your Collection.'
              : 'Viewing your local collection — the records DJDaw saves'
          }
        >
          {scopeLabel}
        </div>

        <div className="browser-count mono">
          {search.trim() === '' ? `${scopeCount} tracks` : `${matchCount} / ${scopeCount} tracks`}
        </div>

        <div className="browser-spacer" />

        <div className="browser-sort">
          <span className="label">Sort</span>
          <select
            className="browser-select"
            value={sortBy}
            aria-label="Sort column"
            onChange={(event) => {
              // Reading the option back out of the list keeps the value typed
              // as a Track key instead of casting the raw select string.
              const option = SORT_OPTIONS.find((o) => o.key === event.target.value)
              if (option && option.key !== sortBy) setSort(option.key)
            }}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="browser-sort-dir"
            title={sortDir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
            aria-label="Reverse sort direction"
            onClick={() => setSort(sortBy)}
          >
            <svg width="8" height="6" viewBox="0 0 8 6">
              <path
                d={sortDir === 'asc' ? 'M0 5.5 L4 0.5 L8 5.5 Z' : 'M0 0.5 L4 5.5 L8 0.5 Z'}
                fill="currentColor"
              />
            </svg>
          </button>
        </div>

        <button
          type="button"
          className="browser-import browser-import--rekordbox"
          disabled={importing}
          title={
            'One-shot import: copies a rekordbox XML export into your local Collection, ' +
            'grids and hot cues included. To browse rekordbox without copying it, connect ' +
            'the XML on the rekordbox node in the tree instead.'
          }
          onClick={() => void onImportRekordbox()}
        >
          REKORDBOX XML
        </button>

        <button
          type="button"
          className="browser-import"
          disabled={importing}
          onClick={() => void onImport()}
        >
          {importing ? 'IMPORTING…' : '+ IMPORT TRACKS'}
        </button>
      </div>

      {/* A failed sync empties the mirror, and an empty table with no
          explanation reads as "rekordbox has no tracks". Say what went wrong,
          and stay up until a sync succeeds rather than fading like a notice. */}
      {scope === 'rekordbox' && mirrorMeta.error && (
        <div className="browser-error" role="alert">
          <span className="browser-error-text">
            Could not read the rekordbox XML: {mirrorMeta.error}
          </span>
          <button
            type="button"
            title="Try reading the remembered XML again"
            onClick={() => {
              void syncRekordbox().catch((err: unknown) => {
                console.error('[browser] rekordbox sync failed', err)
              })
            }}
          >
            Retry
          </button>
        </div>
      )}

      <div className="browser-body">
        <TreeSidebar />
        <TrackTable onNotice={notify} />
      </div>

      {dragging && <div className="browser-drop">Drop audio files to import</div>}

      {notice && (
        <div className="browser-notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            className="browser-notice-close"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
          >
            <svg width="8" height="8" viewBox="0 0 8 8">
              <path d="M1 1 L7 7 M7 1 L1 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
