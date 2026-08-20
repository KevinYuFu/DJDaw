import { Fragment, useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { ancestorPaths } from '@shared/playlistTree'
import type { PlaylistNode } from '@shared/playlistTree'
import { useLibrary } from '@renderer/state/useLibrary'

/**
 * The browser's left column: rekordbox's source tree, and the home of the
 * two-collection split.
 *
 * Collection and rekordbox are both real nodes and both selectable, because
 * choosing one is what switches the table between the local records and the
 * read-only mirror. The rekordbox node also carries the connection state — the
 * XML it mirrors, how old that export is, and the actions that change it —
 * since that is the only place in the UI where the mirror can be reasoned
 * about as a whole.
 *
 * Under it hangs rekordbox's own folder structure: All, then the playlist
 * tree. A 2,700 track export shown as one flat list is not a library, so the
 * tree is the only way most of it can be reached.
 *
 * History and related tracks are still to come. They are rendered as disabled
 * nodes rather than hidden so the tree keeps its final shape and the gap is
 * visible instead of looking like a feature nobody thought of.
 */

interface PendingNodeSpec {
  id: string
  label: string
  /** The reason the node is a placeholder, shown as its tooltip. */
  pending: string
}

const PENDING_NODES: readonly PendingNodeSpec[] = [
  { id: 'histories', label: 'Histories', pending: 'Histories are not implemented yet' },
  { id: 'related', label: 'Related Tracks', pending: 'Related Tracks is not implemented yet' }
]

/**
 * The one thing a user must not be wrong about: this is not a live link.
 * rekordbox writes this file when it quits (with Auto Export on) or on a manual
 * export, so the mirror is only ever as fresh as the last
 * time the user exported by hand.
 */
const REKORDBOX_TITLE =
  'Read-only mirror of a rekordbox XML export. DJDaw re-reads the file whenever ' +
  'it changes. rekordbox writes it when it quits, if you turn on Auto Export — ' +
  'see SETUP at the top. So this is as fresh as the last time rekordbox closed.'

const MISSING_TITLE =
  'Files the export points at that are not on this machine right now, usually an ' +
  'unmounted drive. They are listed but cannot be played.'

const ALL_TITLE = 'Every track in the export'

/** Indent per tree level, in pixels, plus the panel's own left padding. */
const INDENT = 13
const PADDING_LEFT = 6

/** The level the playlist tree starts at: a child of the rekordbox node. */
const PLAYLIST_DEPTH = 2

/**
 * Playlist folders indent more tightly than the fixed tree above them, and
 * stop indenting past a point, because rekordbox folders nest several levels
 * deep and the column is only 190px wide. Past that depth the parent row above
 * still says where a node sits, but a name that has been squeezed to an
 * ellipsis says nothing at all.
 */
const PLAYLIST_INDENT = 10
const MAX_PLAYLIST_INDENT_DEPTH = 6

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** How often the "synced ... ago" readout is recomputed while it is on screen. */
const AGE_TICK_MS = 30_000

/**
 * Coarse age of an export: "just now", "4 min ago", "2 days ago".
 *
 * Deliberately imprecise — what matters is whether the export is minutes or
 * days old, never the exact second it was written.
 */
function formatAge(then: number, now: number): string {
  const age = Math.max(0, now - then)
  if (age < MINUTE_MS) return 'just now'
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)} min ago`
  if (age < DAY_MS) {
    const hours = Math.floor(age / HOUR_MS)
    return `${hours} hour${hours === 1 ? '' : 's'} ago`
  }
  const days = Math.floor(age / DAY_MS)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut >= 0 ? path.slice(cut + 1) : path
}

/** A clock that only ticks while something on screen is displaying an age. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    // Re-read on activation as well: the value may have gone stale while no
    // age was being shown and the interval was not running.
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), AGE_TICK_MS)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function Chevron({ open, hidden }: { open: boolean; hidden: boolean }): ReactElement {
  return (
    <span className={`tree-chevron${open ? ' tree-chevron--open' : ''}`} aria-hidden="true">
      {hidden ? null : (
        <svg width="8" height="8" viewBox="0 0 8 8">
          <path d="M2.5 0.5 L6 4 L2.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )}
    </span>
  )
}

interface TreeRowProps {
  label: string
  depth: number
  /** Extra levels below `depth`, indented on the tighter playlist step. */
  subDepth?: number
  selected: boolean
  disabled: boolean
  /** null when the node cannot have children, so no chevron is drawn. */
  expanded: boolean | null
  count?: number
  title?: string
  onClick?: () => void
}

function TreeRow({
  label,
  depth,
  subDepth = 0,
  selected,
  disabled,
  expanded,
  count,
  title,
  onClick
}: TreeRowProps): ReactElement {
  const classes = ['tree-node']
  if (selected) classes.push('tree-node--selected')
  if (disabled) classes.push('tree-node--disabled')

  const indent =
    PADDING_LEFT +
    depth * INDENT +
    Math.min(subDepth, MAX_PLAYLIST_INDENT_DEPTH) * PLAYLIST_INDENT

  return (
    <div
      className={classes.join(' ')}
      style={{ paddingLeft: indent }}
      role="treeitem"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      aria-expanded={expanded ?? undefined}
      title={title}
      onClick={disabled ? undefined : onClick}
    >
      <Chevron open={expanded === true} hidden={expanded === null} />
      <span className="tree-label">{label}</span>
      {count != null && <span className="tree-count">{count.toLocaleString()}</span>}
    </div>
  )
}

interface PlaylistBranchProps {
  nodes: readonly PlaylistNode[]
  /** Levels below the top of the playlist tree. */
  depth: number
  openPaths: ReadonlySet<string>
  selectedPath: string | null
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}

/**
 * One level of the playlist tree, recursing only into open folders.
 *
 * Skipping closed folders is what keeps hundreds of playlists cheap: a
 * collapsed tree renders its roots and nothing else.
 */
function PlaylistBranch({
  nodes,
  depth,
  openPaths,
  selectedPath,
  onToggle,
  onSelect
}: PlaylistBranchProps): ReactElement {
  return (
    <>
      {nodes.map((node) => {
        const isFolder = node.kind === 'folder'
        const open = isFolder && openPaths.has(node.path)
        return (
          <Fragment key={node.path}>
            <TreeRow
              label={node.name}
              depth={PLAYLIST_DEPTH}
              subDepth={depth}
              selected={!isFolder && node.path === selectedPath}
              disabled={false}
              // A folder is not a track view, so clicking it only opens it.
              expanded={isFolder ? open : null}
              count={node.count}
              title={node.name}
              onClick={() => (isFolder ? onToggle(node.path) : onSelect(node.path))}
            />
            {open && node.children.length > 0 && (
              <PlaylistBranch
                nodes={node.children}
                depth={depth + 1}
                openPaths={openPaths}
                selectedPath={selectedPath}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </Fragment>
        )
      })}
    </>
  )
}

export function TreeSidebar(): ReactElement {
  const localCount = useLibrary((s) => s.order.length)
  const mirrorCount = useLibrary((s) => s.mirrorOrder.length)
  const mirrorMeta = useLibrary((s) => s.mirrorMeta)
  const scope = useLibrary((s) => s.scope)
  const setScope = useLibrary((s) => s.setScope)
  const playlistTree = useLibrary((s) => s.playlistTree)
  const playlistPath = useLibrary((s) => s.playlistPath)
  const selectPlaylist = useLibrary((s) => s.selectPlaylist)
  const chooseRekordboxXml = useLibrary((s) => s.chooseRekordboxXml)
  const syncRekordbox = useLibrary((s) => s.syncRekordbox)
  const clearRekordboxXml = useLibrary((s) => s.clearRekordboxXml)

  const [rootOpen, setRootOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  /**
   * Which playlist folders are open, by `PlaylistNode.path`. Everything starts
   * closed — opening the app onto hundreds of playlist names would be worse
   * than the flat list this replaces. Held by path rather than by node so a
   * re-sync rebuilds the tree without closing what the user opened.
   */
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(() => new Set())

  const { xmlPath, syncedAt, missing, producedBy } = mirrorMeta
  const error = mirrorMeta.error ?? null
  const now = useNow(rootOpen && syncedAt > 0)

  const toggleFolder = useCallback((path: string) => {
    setOpenPaths((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }, [])

  // Keep the selected playlist reachable. Selecting one from the tree already
  // has its folders open, but a selection restored from elsewhere would
  // otherwise sit inside closed folders with nothing on screen to explain what
  // the table is showing.
  useEffect(() => {
    if (!playlistPath) return
    setOpenPaths((prev) => {
      const missingPaths = ancestorPaths(playlistPath).filter((p) => !prev.has(p))
      if (missingPaths.length === 0) return prev
      const next = new Set(prev)
      for (const p of missingPaths) next.add(p)
      return next
    })
  }, [playlistPath])

  /** Actions run one at a time: two overlapping syncs would fight over the mirror. */
  const run = useCallback(async (what: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } catch (err) {
      // The failure itself surfaces through mirrorMeta.error, which the browser
      // shows; this is only here so the stack is not swallowed.
      console.error(`[browser] rekordbox ${what} failed`, err)
    } finally {
      setBusy(false)
    }
  }, [])

  const onRekordbox = scope === 'rekordbox'

  return (
    <div className="tree-sidebar" role="tree" aria-label="Browse">
      <div className="tree-sidebar-title label">Browse</div>

      <TreeRow
        label="DJDaw"
        depth={0}
        selected={false}
        disabled={false}
        expanded={rootOpen}
        onClick={() => setRootOpen((open) => !open)}
      />

      {rootOpen && (
        <>
          <TreeRow
            label="Collection"
            depth={1}
            selected={scope === 'collection'}
            disabled={false}
            expanded={null}
            count={localCount}
            title="Your local records — the collection DJDaw saves"
            onClick={() => setScope('collection')}
          />

          <TreeRow
            label="rekordbox"
            depth={1}
            selected={onRekordbox}
            disabled={false}
            expanded={null}
            count={mirrorCount}
            title={REKORDBOX_TITLE}
            onClick={() => setScope('rekordbox')}
          />

          <div className="tree-detail" style={{ paddingLeft: PADDING_LEFT + 2 * INDENT }}>
            {xmlPath ? (
              <>
                <div
                  className="tree-detail-line"
                  title={producedBy ? `${xmlPath}\nExported by ${producedBy}` : xmlPath}
                >
                  {basename(xmlPath)}
                </div>
                <div className="tree-detail-line" title={REKORDBOX_TITLE}>
                  {syncedAt > 0 ? `synced ${formatAge(syncedAt, now)}` : 'not synced yet'}
                </div>
                {missing > 0 && (
                  <div className="tree-detail-line tree-detail-line--warn" title={MISSING_TITLE}>
                    {missing.toLocaleString()} file{missing === 1 ? '' : 's'} not found
                  </div>
                )}
                {error && (
                  <div className="tree-detail-line tree-detail-line--error" title={error}>
                    last sync failed
                  </div>
                )}
                <div className="tree-actions">
                  <button
                    type="button"
                    className="tree-action"
                    disabled={busy}
                    title="Re-read the XML now. It only changes when rekordbox exports it again."
                    onClick={() => void run('sync', syncRekordbox)}
                  >
                    {busy ? 'Syncing…' : 'Sync now'}
                  </button>
                  <button
                    type="button"
                    className="tree-action"
                    disabled={busy}
                    title="Forget this XML and empty the mirror. Local records are untouched."
                    onClick={() => void run('disconnect', clearRekordboxXml)}
                  >
                    Disconnect
                  </button>
                </div>
              </>
            ) : (
              <div className="tree-actions">
                <button
                  type="button"
                  className="tree-action"
                  disabled={busy}
                  title="Pick the XML that rekordbox writes from File > Export Collection in xml format"
                  onClick={() => void run('choose', chooseRekordboxXml)}
                >
                  {busy ? 'Reading…' : 'Choose XML…'}
                </button>
              </div>
            )}
          </div>

          {mirrorCount > 0 && (
            <>
              <TreeRow
                label="All"
                depth={PLAYLIST_DEPTH}
                selected={onRekordbox && playlistPath === null}
                disabled={false}
                expanded={null}
                count={mirrorCount}
                title={ALL_TITLE}
                onClick={() => selectPlaylist(null)}
              />

              {playlistTree.length > 0 ? (
                <PlaylistBranch
                  nodes={playlistTree}
                  depth={0}
                  openPaths={openPaths}
                  selectedPath={onRekordbox ? playlistPath : null}
                  onToggle={toggleFolder}
                  onSelect={selectPlaylist}
                />
              ) : (
                <div
                  className="tree-note"
                  style={{ paddingLeft: PADDING_LEFT + PLAYLIST_DEPTH * INDENT }}
                >
                  No playlists
                </div>
              )}
            </>
          )}

          {PENDING_NODES.map((node) => (
            <TreeRow
              key={node.id}
              label={node.label}
              depth={1}
              selected={false}
              disabled={true}
              // The pending nodes show a chevron so it is obvious they are
              // meant to open into something.
              expanded={false}
              title={node.pending}
            />
          ))}
        </>
      )}
    </div>
  )
}
