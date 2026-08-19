import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
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
 * Playlists, history and related tracks are still to come. They are rendered as
 * disabled nodes rather than hidden so the tree keeps its final shape and the
 * gap is visible instead of looking like a feature nobody thought of.
 */

interface PendingNodeSpec {
  id: string
  label: string
  /** The reason the node is a placeholder, shown as its tooltip. */
  pending: string
}

const PENDING_NODES: readonly PendingNodeSpec[] = [
  { id: 'playlists', label: 'Playlists', pending: 'Playlists are not implemented yet' },
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

/** Indent per tree level, in pixels, plus the panel's own left padding. */
const INDENT = 13
const PADDING_LEFT = 6

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

  return (
    <div
      className={classes.join(' ')}
      style={{ paddingLeft: PADDING_LEFT + depth * INDENT }}
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

export function TreeSidebar(): ReactElement {
  const localCount = useLibrary((s) => s.order.length)
  const mirrorCount = useLibrary((s) => s.mirrorOrder.length)
  const mirrorMeta = useLibrary((s) => s.mirrorMeta)
  const scope = useLibrary((s) => s.scope)
  const setScope = useLibrary((s) => s.setScope)
  const chooseRekordboxXml = useLibrary((s) => s.chooseRekordboxXml)
  const syncRekordbox = useLibrary((s) => s.syncRekordbox)
  const clearRekordboxXml = useLibrary((s) => s.clearRekordboxXml)

  const [rootOpen, setRootOpen] = useState(true)
  const [busy, setBusy] = useState(false)

  const { xmlPath, syncedAt, missing, producedBy } = mirrorMeta
  const error = mirrorMeta.error ?? null
  const now = useNow(rootOpen && syncedAt > 0)

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
            selected={scope === 'rekordbox'}
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
