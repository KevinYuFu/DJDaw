import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { DeckId, Track } from '@shared/types'
import { formatBpm, formatDuration } from '@renderer/core/format'
import { makeGrid } from '@renderer/core/beatgrid'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { decodeTrack } from '@renderer/audio/decode'
import { analyzeWaveform, encodeWaveform } from '@renderer/analysis/waveform'
import { detectTempo } from '@renderer/analysis/bpm'
import { useDecks } from '@renderer/state/useDecks'
import { useLibrary } from '@renderer/state/useLibrary'
import { useSettings } from '@renderer/state/useSettings'

/**
 * The track list.
 *
 * Rows are windowed: only the slice that can be on screen is in the DOM, which
 * keeps scrolling flat whether the collection is fifty tracks or fifty
 * thousand. That needs a fixed row height, so ROW_HEIGHT and HEADER_HEIGHT
 * below mirror `.tt-row` / `.tt-head` in browser.css and have to move with them.
 */

const ROW_HEIGHT = 22
const HEADER_HEIGHT = 24
/** Rows rendered beyond each edge of the viewport, so a fast flick stays filled. */
const OVERSCAN = 8

const MAX_RATING = 5
/** En dash, for a value the track simply does not have yet. */
const EMPTY = '–'

interface ColumnSpec {
  id: string
  label: string
  /** Column this header sorts by, or null when it is not sortable. */
  sortKey: keyof Track | null
}

const COLUMNS: readonly ColumnSpec[] = [
  { id: 'artwork', label: '', sortKey: null },
  { id: 'index', label: '#', sortKey: null },
  { id: 'source', label: '', sortKey: null },
  { id: 'title', label: 'Title', sortKey: 'title' },
  { id: 'artist', label: 'Artist', sortKey: 'artist' },
  { id: 'bpm', label: 'BPM', sortKey: 'bpm' },
  { id: 'key', label: 'Key', sortKey: 'key' },
  { id: 'rating', label: 'Rating', sortKey: 'rating' },
  { id: 'time', label: 'Time', sortKey: 'durationSec' },
  { id: 'genre', label: 'Genre', sortKey: 'genre' },
  { id: 'dateAdded', label: 'Date Added', sortKey: 'dateAdded' }
]

/** Roughly the rendered menu, for keeping it inside the window. */
const MENU_WIDTH = 186
const MENU_HEIGHT = 132

/**
 * Why a mirrored row is marked at all: any edit to one silently forks it into
 * the local collection, so the row you are about to change is not the row you
 * will end up with. Better to say so before the click than after.
 */
const MIRROR_TITLE =
  'Mirrored from rekordbox, read-only. Editing it — a hot cue, the grid, a ' +
  'rating — copies it into your Collection and the edit lands on that copy.'

const REMOVE_MIRRORED_TITLE =
  'The rekordbox mirror is rebuilt from the XML on every sync, so removing a ' +
  'row from it would do nothing. Remove the track in rekordbox and export again.'

interface MenuState {
  x: number
  y: number
  trackId: string
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** `YYYY-MM-DD`: scans better than a locale date in a dense column. */
function formatDate(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return EMPTY
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

const DECK_IDS: readonly DeckId[] = ['A', 'B']

/**
 * Track ids with an off-deck analysis running. The guard is module level
 * because the row menu and the app menu both come through here, and two
 * detections of one file would decode it twice and race two grids into it.
 */
const analyzingOffDeck = new Set<string>()

export interface AnalyzeResult {
  /** The id the result landed on: a fork's, when the track was mirrored. */
  id: string
  /** The BPM the track ended up with, which is not the detected one when a
   *  hand-corrected grid won. */
  bpm: number
  /** True when a grid edited while detection ran was kept instead of replaced. */
  keptEditedGrid: boolean
}

/**
 * Analyse a track without putting it on a deck: decode, run both analysers,
 * write the waveform cache, persist the grid. The engine's own context does
 * the decode so the cached waveform is bucketed at the sample rate the deck
 * will play it back at.
 *
 * Nothing here touches the transport — analysing something in the browser must
 * never disturb what a deck is playing — so the app menu's Analyze command
 * shares it. Returns null when the same analysis is already in flight or the
 * track left the collection before the result came back.
 */
export async function analyzeTrackOffDeck(track: Track): Promise<AnalyzeResult | null> {
  if (analyzingOffDeck.has(track.id)) return null
  analyzingOffDeck.add(track.id)
  try {
    const engine = AudioEngine.shared()
    await engine.init()
    // Sampled before the first await: everything after this is a chance for the
    // grid to be edited by hand on a deck while the file is being ground through.
    const gridBefore = useLibrary.getState().trackById(track.id)?.grid ?? null

    const buffer = await decodeTrack(engine.ctx, track.path)
    const [waveform, tempo] = await Promise.all([analyzeWaveform(buffer), detectTempo(buffer)])
    // Keyed on the audio key rather than the id, so a mirrored record and any
    // fork of it — the same file either way — share one cached analysis.
    await window.api.writeWaveformCache(track.audioKey, encodeWaveform(waveform))

    // Detection takes seconds, so the library is re-read rather than written
    // back from the stale record this started with: the track may be gone, and
    // a grid the user corrected in the meantime is their answer, not ours.
    const current = useLibrary.getState().trackById(track.id)
    if (!current) return null
    const keptEditedGrid = current.grid !== gridBefore
    if (keptEditedGrid) {
      // Writing to a mirrored record forks it, so the id that comes back is
      // the one the result belongs to and the one callers must adopt.
      const id = useLibrary.getState().updateTrack(track.id, { analyzed: true })
      if (!id) return null
      return { id, bpm: current.grid?.anchors[0].bpm ?? tempo.bpm, keptEditedGrid }
    }
    const id = useLibrary.getState().updateTrack(track.id, {
      grid: makeGrid(tempo.firstBeatTime, tempo.bpm),
      bpm: tempo.bpm,
      analyzed: true
    })
    if (!id) return null
    return { id, bpm: tempo.bpm, keptEditedGrid }
  } finally {
    analyzingOffDeck.delete(track.id)
  }
}

/** Typing in a field must never be read as table navigation. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

function SortArrow({ dir }: { dir: 'asc' | 'desc' }): ReactElement {
  return (
    <span className="tt-sort-arrow" aria-hidden="true">
      <svg width="7" height="5" viewBox="0 0 7 5">
        <path d={dir === 'asc' ? 'M0 4.5 L3.5 0.5 L7 4.5 Z' : 'M0 0.5 L3.5 4.5 L7 0.5 Z'} fill="currentColor" />
      </svg>
    </span>
  )
}

/** Stand-in cover: a note glyph rather than an empty hole in the column. */
function ArtworkPlaceholder(): ReactElement {
  return (
    <span className="tt-art tt-art--empty" aria-hidden="true">
      <svg width="10" height="10" viewBox="0 0 10 10">
        <path d="M4 8.2 V2.2 L8.4 1.1 V7" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
        <circle cx="2.7" cy="8.2" r="1.3" fill="currentColor" />
        <circle cx="7.1" cy="7" r="1.3" fill="currentColor" />
      </svg>
    </span>
  )
}

interface StarsProps {
  trackId: string
  rating: number
  onRate: (id: string, rating: number) => void
}

function Stars({ trackId, rating, onRate }: StarsProps): ReactElement {
  const stars: ReactElement[] = []
  for (let i = 1; i <= MAX_RATING; i++) {
    stars.push(
      <span
        key={i}
        className={i <= rating ? 'tt-star tt-star--on' : 'tt-star'}
        role="button"
        aria-label={`${i} star${i === 1 ? '' : 's'}`}
        title={`Rate ${i}`}
        onClick={(event) => {
          event.stopPropagation()
          // Clicking the current rating clears it, the way rekordbox's stars do.
          onRate(trackId, i === rating ? 0 : i)
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {'★'}
      </span>
    )
  }
  return <span className="tt-stars">{stars}</span>
}

interface TrackRowProps {
  track: Track
  index: number
  selected: boolean
  analyzing: boolean
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onMenu: (event: ReactMouseEvent, id: string) => void
  onRate: (id: string, rating: number) => void
}

const TrackRow = memo(function TrackRow({
  track,
  index,
  selected,
  analyzing,
  onSelect,
  onOpen,
  onMenu,
  onRate
}: TrackRowProps): ReactElement {
  const mirrored = track.source === 'rekordbox'
  const classes = ['tt-row']
  if (index % 2 === 1) classes.push('tt-row--odd')
  if (mirrored) classes.push('tt-row--mirrored')
  if (selected) classes.push('tt-row--selected')

  // Analysis is what produces a tempo worth beat matching to, so a value a tag
  // claimed before then is shown a shade back rather than as fact.
  const soft = track.analyzed ? undefined : 'tt-unanalyzed'

  return (
    <div
      className={classes.join(' ')}
      style={{ top: index * ROW_HEIGHT }}
      role="row"
      aria-selected={selected}
      title={`${track.title} — ${track.artist}`}
      onClick={() => onSelect(track.id)}
      onDoubleClick={() => onOpen(track.id)}
      onContextMenu={(event) => onMenu(event, track.id)}
    >
      <span className="tt-art-cell">
        {track.artwork ? (
          <img className="tt-art" src={track.artwork} alt="" draggable={false} />
        ) : (
          <ArtworkPlaceholder />
        )}
      </span>
      <span className="tt-cell tt-cell--num tt-cell--index">{index + 1}</span>
      <span className="tt-cell tt-cell--source">
        {mirrored && (
          <span className="tt-rb" title={MIRROR_TITLE}>
            RB
          </span>
        )}
      </span>
      <span className="tt-cell tt-cell--title">{track.title}</span>
      <span className="tt-cell tt-cell--sub">{track.artist}</span>
      <span className="tt-cell tt-cell--num">
        {analyzing ? (
          <span className="tt-analyzing">{'···'}</span>
        ) : track.bpm == null ? (
          <span className="tt-empty-value">{EMPTY}</span>
        ) : (
          <span className={soft}>{formatBpm(track.bpm)}</span>
        )}
      </span>
      <span className="tt-cell">
        {track.key ? <span className={soft}>{track.key}</span> : <span className="tt-empty-value">{EMPTY}</span>}
      </span>
      <Stars trackId={track.id} rating={track.rating} onRate={onRate} />
      <span className="tt-cell tt-cell--num tt-cell--sub">{formatDuration(track.durationSec)}</span>
      <span className="tt-cell tt-cell--sub">{track.genre || <span className="tt-empty-value">{EMPTY}</span>}</span>
      <span className="tt-cell tt-cell--num tt-cell--sub">{formatDate(track.dateAdded)}</span>
    </div>
  )
})

export interface TrackTableProps {
  /** Surfaces analysis and load results in the browser's notice strip. */
  onNotice?: (message: string) => void
}

export function TrackTable({ onNotice }: TrackTableProps): ReactElement {
  const tracks = useLibrary((s) => s.tracks)
  const order = useLibrary((s) => s.order)
  const mirror = useLibrary((s) => s.mirror)
  const mirrorOrder = useLibrary((s) => s.mirrorOrder)
  const scope = useLibrary((s) => s.scope)
  const playlistPath = useLibrary((s) => s.playlistPath)
  const playlistTree = useLibrary((s) => s.playlistTree)
  const sortActive = useLibrary((s) => s.sortActive)
  const trackById = useLibrary((s) => s.trackById)
  const search = useLibrary((s) => s.search)
  const sortBy = useLibrary((s) => s.sortBy)
  const sortDir = useLibrary((s) => s.sortDir)
  const selectedId = useLibrary((s) => s.selectedId)
  const select = useLibrary((s) => s.select)
  const setSort = useLibrary((s) => s.setSort)
  const removeTrack = useLibrary((s) => s.removeTrack)
  const updateTrack = useLibrary((s) => s.updateTrack)
  const loadTrack = useDecks((s) => s.loadTrack)
  const focusedDeck = useSettings((s) => s.focusedDeck)

  // visibleTracks() is a method rather than stored state, so the inputs it
  // reads are subscribed to individually and the result recomputed from them.
  // That now includes the mirror and the scope: switching collections has to
  // rebuild the rows even though nothing about the local records changed.
  const rows = useMemo(
    () => useLibrary.getState().visibleTracks(),
    [
      tracks,
      order,
      mirror,
      mirrorOrder,
      scope,
      search,
      sortBy,
      sortDir,
      // Picking a playlist changes the rows without touching the mirror, and
      // playlist order only applies until a column is chosen, so both belong
      // here or the table would keep showing the previous selection.
      playlistPath,
      playlistTree,
      sortActive
    ]
  )
  /** Rows in the collection on screen before the search narrows them. */
  const scopeCount =
    scope === 'rekordbox' ? (playlistPath ? rows.length : mirrorOrder.length) : order.length

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [analyzing, setAnalyzing] = useState<ReadonlySet<string>>(() => new Set())
  // Mirrors `analyzing`, so a repeated Analyze can be rejected synchronously.
  const analyzingRef = useRef<Set<string>>(new Set())

  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return undefined
    setViewport(el.clientHeight)
    const observer = new ResizeObserver(() => setViewport(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const first = Math.max(0, Math.floor((scrollTop - HEADER_HEIGHT) / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((scrollTop - HEADER_HEIGHT + viewport) / ROW_HEIGHT) + OVERSCAN)
  const visible = rows.slice(first, Math.max(first, last))

  /** Scroll `index` into view, allowing for the sticky header that overlaps it. */
  const revealRow = useCallback((index: number): void => {
    const el = scrollerRef.current
    if (!el) return
    const highest = index * ROW_HEIGHT
    const lowest = HEADER_HEIGHT + (index + 1) * ROW_HEIGHT - el.clientHeight
    if (el.scrollTop > highest) el.scrollTop = highest
    else if (el.scrollTop < lowest) el.scrollTop = lowest
  }, [])

  const openInDeck = useCallback(
    (deck: DeckId, trackId: string): void => {
      select(trackId)
      void loadTrack(deck, trackId).catch((err: unknown) => {
        onNotice?.(`Could not load track: ${messageOf(err)}`)
      })
    },
    [loadTrack, onNotice, select]
  )

  const handleSelect = useCallback(
    (trackId: string): void => {
      select(trackId)
    },
    [select]
  )

  const handleOpen = useCallback(
    (trackId: string): void => {
      openInDeck(focusedDeck, trackId)
    },
    [focusedDeck, openInDeck]
  )

  const handleRate = useCallback(
    (trackId: string, rating: number): void => {
      // Rating a mirrored row forks it, and the selection has to follow the
      // fork: leaving it on the mirror would fork again on the next star.
      const written = updateTrack(trackId, { rating })
      select(written ?? trackId)
    },
    [select, updateTrack]
  )

  const handleMenu = useCallback(
    (event: ReactMouseEvent, trackId: string): void => {
      event.preventDefault()
      select(trackId)
      setMenu({
        x: Math.max(0, Math.min(event.clientX, window.innerWidth - MENU_WIDTH - 4)),
        y: Math.max(0, Math.min(event.clientY, window.innerHeight - MENU_HEIGHT - 4)),
        trackId
      })
    },
    [select]
  )

  const markAnalyzing = useCallback((trackId: string, active: boolean): void => {
    if (active) analyzingRef.current.add(trackId)
    else analyzingRef.current.delete(trackId)
    setAnalyzing(new Set(analyzingRef.current))
  }, [])

  /** The row menu's Analyze: {@link analyzeTrackOffDeck} plus its row spinner. */
  const analyze = useCallback(
    async (track: Track): Promise<void> => {
      if (analyzingRef.current.has(track.id)) return
      markAnalyzing(track.id, true)
      try {
        const result = await analyzeTrackOffDeck(track)
        if (!result) return
        // Analysing a mirrored row forked it; follow the fork so the next
        // action operates on the record that now holds the grid.
        if (result.id !== track.id && useLibrary.getState().selectedId === track.id) {
          select(result.id)
        }
        onNotice?.(
          result.keptEditedGrid
            ? `Analyzed "${track.title}" — kept the grid you edited while it ran`
            : `Analyzed "${track.title}" — ${formatBpm(result.bpm)} BPM`
        )
      } catch (err) {
        console.error('[browser] analysis failed', track.path, err)
        onNotice?.(`Analysis failed for "${track.title}": ${messageOf(err)}`)
      } finally {
        markAnalyzing(track.id, false)
      }
    },
    [markAnalyzing, onNotice, select]
  )

  /**
   * Remove a track from the collection, ejecting it from any deck holding it.
   *
   * A deck whose track has been deleted has nothing left to drive its transport
   * or its waveform, so a loaded track is never removed silently: the removal
   * is confirmed, and the decks are ejected before the record goes.
   */
  const removeFromCollection = useCallback(
    (track: Track): void => {
      const decks = useDecks.getState()
      const loaded = DECK_IDS.filter((id) => decks.decks[id].trackId === track.id)
      if (loaded.length > 0) {
        const where = loaded.map((id) => `deck ${id}`).join(' and ')
        const held = loaded.some((id) => decks.decks[id].playing) ? 'playing on' : 'loaded on'
        const eject = loaded.length > 1 ? 'eject those decks' : 'eject that deck'
        if (!window.confirm(`"${track.title}" is ${held} ${where}.\n\nRemove it from the collection and ${eject}?`)) {
          return
        }
        for (const id of loaded) decks.unloadDeck(id)
        onNotice?.(`Removed "${track.title}" and ejected ${where}`)
      }
      removeTrack(track.id)
    },
    [onNotice, removeTrack]
  )

  const reveal = useCallback(
    (track: Track): void => {
      void window.api.revealInFinder(track.path).catch((err: unknown) => {
        onNotice?.(`Could not reveal "${track.title}": ${messageOf(err)}`)
      })
    },
    [onNotice]
  )

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (isTextEntry(event.target) || rows.length === 0) return
      const current = rows.findIndex((t) => t.id === selectedId)
      const page = Math.max(1, Math.floor((viewport - HEADER_HEIGHT) / ROW_HEIGHT) - 1)

      let next: number
      switch (event.key) {
        case 'ArrowDown':
          next = current < 0 ? 0 : Math.min(rows.length - 1, current + 1)
          break
        case 'ArrowUp':
          next = current < 0 ? rows.length - 1 : Math.max(0, current - 1)
          break
        case 'PageDown':
          next = Math.min(rows.length - 1, Math.max(0, current) + page)
          break
        case 'PageUp':
          next = Math.max(0, Math.max(0, current) - page)
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = rows.length - 1
          break
        case 'Enter':
          if (current >= 0) {
            event.preventDefault()
            openInDeck(focusedDeck, rows[current].id)
          }
          return
        default:
          return
      }

      event.preventDefault()
      select(rows[next].id)
      revealRow(next)
    },
    [focusedDeck, openInDeck, revealRow, rows, select, selectedId, viewport]
  )

  // Dismiss the context menu on anything that could move what it points at.
  useEffect(() => {
    if (!menu) return undefined
    const close = (): void => setMenu(null)
    const onMouseDown = (event: MouseEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  // The menu may point at a mirrored row, which is not in `tracks`.
  const menuTrack = menu ? trackById(menu.trackId) : undefined
  const runAndClose = (action: () => void): void => {
    setMenu(null)
    action()
  }

  return (
    <div className="tt">
      <div
        className="tt-scroll"
        ref={scrollerRef}
        tabIndex={0}
        role="grid"
        aria-label="Tracks"
        aria-rowcount={rows.length}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onMouseDown={() => scrollerRef.current?.focus()}
        onKeyDown={onKeyDown}
      >
        <div className="tt-head" role="row">
          {COLUMNS.map((col) => {
            const sortKey = col.sortKey
            const active = sortKey != null && sortKey === sortBy
            const classes = ['tt-head-cell']
            if (sortKey) classes.push('tt-head-cell--sortable')
            if (active) classes.push('tt-head-cell--active')
            return (
              <span
                key={col.id}
                className={classes.join(' ')}
                role="columnheader"
                aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                title={sortKey ? `Sort by ${col.label}` : undefined}
                onClick={sortKey ? () => setSort(sortKey) : undefined}
              >
                {col.label}
                {active && <SortArrow dir={sortDir} />}
              </span>
            )
          })}
        </div>

        <div className="tt-body" role="rowgroup" style={{ height: rows.length * ROW_HEIGHT }}>
          {visible.map((track, i) => (
            <TrackRow
              key={track.id}
              track={track}
              index={first + i}
              selected={track.id === selectedId}
              analyzing={analyzing.has(track.id)}
              onSelect={handleSelect}
              onOpen={handleOpen}
              onMenu={handleMenu}
              onRate={handleRate}
            />
          ))}
        </div>

        {rows.length === 0 && (
          <div className="tt-placeholder">
            {scopeCount > 0
              ? `No tracks match "${search}".`
              : scope === 'rekordbox'
                ? 'Nothing mirrored. Connect a rekordbox XML export in the tree on the left.'
                : 'No tracks yet. Use + IMPORT TRACKS above.'}
          </div>
        )}
      </div>

      {menu && menuTrack && (
        <div className="tt-menu" ref={menuRef} style={{ left: menu.x, top: menu.y }} role="menu">
          <button
            type="button"
            className="tt-menu-item"
            role="menuitem"
            onClick={() => runAndClose(() => openInDeck('A', menuTrack.id))}
          >
            Load to Deck A
          </button>
          <button
            type="button"
            className="tt-menu-item"
            role="menuitem"
            onClick={() => runAndClose(() => openInDeck('B', menuTrack.id))}
          >
            Load to Deck B
          </button>
          <div className="tt-menu-sep" />
          <button
            type="button"
            className="tt-menu-item"
            role="menuitem"
            disabled={analyzing.has(menuTrack.id)}
            onClick={() => runAndClose(() => void analyze(menuTrack))}
          >
            {analyzing.has(menuTrack.id) ? 'Analyzing…' : 'Analyze'}
          </button>
          <button
            type="button"
            className="tt-menu-item"
            role="menuitem"
            onClick={() => runAndClose(() => reveal(menuTrack))}
          >
            Reveal in Finder
          </button>
          <div className="tt-menu-sep" />
          {/* The title sits on the wrapper because a disabled button never
              gets the hover that would show its own. */}
          <span
            className="tt-menu-wrap"
            title={menuTrack.source === 'rekordbox' ? REMOVE_MIRRORED_TITLE : undefined}
          >
            <button
              type="button"
              className="tt-menu-item tt-menu-item--danger"
              role="menuitem"
              disabled={menuTrack.source === 'rekordbox'}
              onClick={() => runAndClose(() => removeFromCollection(menuTrack))}
            >
              Remove from Collection
            </button>
          </span>
        </div>
      )}
    </div>
  )
}
