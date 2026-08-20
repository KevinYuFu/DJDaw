import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import type { DeckId, ExportFormat } from '@shared/types'
import { DECK_IDS } from '@shared/types'
import { timelineDuration } from '@shared/clips'
import { encodeWav } from '@shared/wav'
import { renderTimeline } from '@renderer/audio/render'
import type { DeckRenderSpec } from '@renderer/audio/render'
import { useDecks } from '@renderer/state/useDecks'
import type { DeckState } from '@renderer/state/useDecks'
import { useLibrary } from '@renderer/state/useLibrary'
import { useSettings } from '@renderer/state/useSettings'
import { EditTrack } from '@renderer/components/edit/EditTrack'
import './edit.css'

/**
 * 24-bit, always. An export is the master Kevin takes back into rekordbox, so
 * the bounce is the last place to lose depth; MP3 is encoded from these bytes
 * in main, and giving ffmpeg the better input costs nothing.
 */
const BIT_DEPTH = 24

/** Used when the name field is emptied, so an export never goes out unnamed. */
const FALLBACK_NAME = 'DJDaw edit'

/**
 * The likeliest MP3 failure by far, and "export failed" would send Kevin
 * looking in the wrong place. Main sends its own line too, which is kept
 * underneath this one.
 */
const FFMPEG_MISSING = 'MP3 needs ffmpeg, and it was not found. Export WAV instead, or install ffmpeg.'

type ExportScope = 'one' | 'all'

/**
 * Where an export has got to.
 *
 * A render of a long track takes real time, so the panel always has something
 * true to say: which step is running, where the file landed, or what went
 * wrong. It is never just closed and hoped for.
 */
type ExportPhase =
  | { kind: 'idle' }
  | { kind: 'working'; step: string }
  | { kind: 'done'; path: string }
  | { kind: 'error'; message: string; detail?: string }

/** A row is exportable only with audio loaded and something left on its timeline. */
function isExportable(state: DeckState): boolean {
  return state.status === 'ready' && state.buffer !== null && timelineDuration(state.clips) > 0
}

/**
 * The rows that have something to export, as a string like `AB`.
 *
 * A string rather than an array because zustand compares selector results by
 * identity: a fresh array every store change would re-render the view sixty
 * times a second while a deck plays.
 */
function useExportableDecks(): string {
  return useDecks((s) => DECK_IDS.filter((id) => isExportable(s.decks[id])).join(''))
}

/**
 * One render spec per row that has audio, in deck order. Empty rows are
 * skipped rather than refused: exporting all four with one row loaded should
 * give you that row.
 *
 * No `gain` is passed. The channel faders are a monitoring control on the
 * performance mixer, and this view has none — the file is the edit, not the
 * mix position it was last heard at.
 */
function buildSpecs(ids: readonly DeckId[]): DeckRenderSpec[] {
  const { decks } = useDecks.getState()
  const specs: DeckRenderSpec[] = []
  for (const id of ids) {
    const state = decks[id]
    if (!state.buffer || !isExportable(state)) continue
    specs.push({ buffer: state.buffer, clips: state.clips, eq: state.eq })
  }
  return specs
}

/**
 * Strip an extension the user typed, so the format buttons stay the one thing
 * that decides it and nobody ends up with `mix.wav.mp3`. Main sanitises the
 * rest of the name, since only main knows what the filesystem will take.
 */
function cleanName(name: string): string {
  const trimmed = name.trim().replace(/\.(wav|mp3)$/i, '').trim()
  return trimmed.length > 0 ? trimmed : FALLBACK_NAME
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Plain headline plus the raw line underneath, rather than one or the other. */
function describeFailure(message: string, format: ExportFormat): { message: string; detail?: string } {
  if (format === 'mp3' && /ffmpeg/i.test(message)) return { message: FFMPEG_MISSING, detail: message }
  return { message }
}

/**
 * Give the browser a frame before something heavy.
 *
 * Building the render and encoding the WAV both hold the main thread, and a
 * state change queued in the same tick would not have painted yet — the panel
 * would sit on its old text through the whole wait and look frozen.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })
}

interface ExportPanelProps {
  /** Rows that have something to export, as returned by {@link useExportableDecks}. */
  loaded: string
  onClose(): void
}

/**
 * The export panel: format, what to export, a name, and a report of what
 * happened.
 *
 * It is modal because an export reads the decks as they are now — a cut or a
 * clip drag half way through a render would not be in the file, and there is
 * no honest way to show that. Nothing here can be touched while a render runs,
 * closing included.
 */
function ExportPanel({ loaded, onClose }: ExportPanelProps): ReactElement {
  const focused = useSettings((s) => s.focusedDeck)
  const focusedTrackId = useDecks((s) => s.decks[focused].trackId)
  const focusedTitle = useLibrary((s) =>
    focusedTrackId ? s.trackById(focusedTrackId)?.title : undefined
  )

  const focusedReady = loaded.includes(focused)
  const [format, setFormat] = useState<ExportFormat>('wav')
  // A focused row with no audio cannot be "this track", so the panel opens on
  // the choice that can actually run.
  const [scope, setScope] = useState<ExportScope>(focusedReady ? 'one' : 'all')
  const [name, setName] = useState(() => focusedTitle ?? FALLBACK_NAME)
  const [phase, setPhase] = useState<ExportPhase>({ kind: 'idle' })

  const nameField = useRef<HTMLInputElement | null>(null)
  // A render outlives its panel if the view is switched, and writing state
  // into a gone component is how a stray error report appears next time.
  const alive = useRef(true)

  const running = phase.kind === 'working'

  useEffect(
    () => () => {
      alive.current = false
    },
    []
  )

  // The name is the field most likely to be changed, and selecting it means
  // typing replaces it. Focus also takes the keyboard off the global map, so
  // "1" cannot fire a hot cue into a row while the panel is open.
  useEffect(() => {
    nameField.current?.focus()
    nameField.current?.select()
  }, [])

  const targets = (scope === 'one' ? [focused] : DECK_IDS).filter((id) => loaded.includes(id))
  const nothingToExport = targets.length === 0

  const start = async (): Promise<void> => {
    const specs = buildSpecs(targets)
    if (specs.length === 0) {
      setPhase({ kind: 'error', message: 'Nothing to export. Load a track first.' })
      return
    }
    const wanted = cleanName(name)

    try {
      setPhase({ kind: 'working', step: 'Rendering the audio' })
      await nextFrame()
      const rendered = await renderTimeline({ decks: specs })
      if (!alive.current) return

      setPhase({ kind: 'working', step: 'Making the file' })
      await nextFrame()
      const channels = Array.from({ length: rendered.numberOfChannels }, (_, i) =>
        rendered.getChannelData(i)
      )
      const wav = encodeWav(channels, rendered.sampleRate, BIT_DEPTH)
      if (!alive.current) return

      setPhase({ kind: 'working', step: 'Saving the file' })
      const result = await window.api.exportAudio({ wav, format, name: wanted })
      if (!alive.current) return

      if (result.error) {
        setPhase({ kind: 'error', ...describeFailure(result.error, format) })
        return
      }
      // No path and no error is main saying it wrote nothing on purpose, which
      // is not a failure to report.
      if (!result.path) {
        setPhase({ kind: 'idle' })
        return
      }
      setPhase({ kind: 'done', path: result.path })
    } catch (err) {
      console.error('[export] failed', err)
      if (!alive.current) return
      setPhase({ kind: 'error', ...describeFailure(errorText(err), format) })
    }
  }

  const reveal = (path: string): void => {
    void window.api.revealInFinder(path).catch((err: unknown) => {
      console.error('[export] reveal failed', err)
    })
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // The global key map is on window, so every key has to stop here or the
    // row behind the panel acts on it.
    event.stopPropagation()
    if (running) return
    if (event.key === 'Escape') {
      onClose()
      return
    }
    // Enter from the name field is "I have named it, go" — but only from
    // there, since Enter on a button is already that button's click.
    if (event.key === 'Enter' && event.target === nameField.current && !nothingToExport) {
      void start()
    }
  }

  const summary =
    scope === 'one'
      ? `Row ${focused}: ${focusedTitle ?? 'this track'}`
      : targets.length <= 1
        ? `Only row ${targets[0] ?? '-'} has a track. That is what you get.`
        : `Rows ${targets.join(', ')}, mixed into one file.`

  return createPortal(
    <div className="modal-backdrop" onPointerDown={running ? undefined : onClose}>
      <div
        className="modal edit-export"
        role="dialog"
        aria-modal="true"
        aria-label="Export"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <h2 className="modal__title">Export</h2>
          <button type="button" onClick={onClose} disabled={running} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="edit-export__field">
          <span className="label">Format</span>
          <div className="edit-export__choice">
            <button
              type="button"
              className={format === 'wav' ? 'is-on' : undefined}
              aria-pressed={format === 'wav'}
              disabled={running}
              onClick={() => setFormat('wav')}
              title="Full quality. Big file."
            >
              WAV
            </button>
            <button
              type="button"
              className={format === 'mp3' ? 'is-on' : undefined}
              aria-pressed={format === 'mp3'}
              disabled={running}
              onClick={() => setFormat('mp3')}
              title="Smaller file. Needs ffmpeg."
            >
              MP3
            </button>
          </div>
        </div>

        <div className="edit-export__field">
          <span className="label">What</span>
          <div className="edit-export__choice">
            <button
              type="button"
              className={scope === 'one' ? 'is-on' : undefined}
              aria-pressed={scope === 'one'}
              disabled={running || !focusedReady}
              onClick={() => setScope('one')}
              title={focusedReady ? 'The row you are working on' : 'This row has no track'}
            >
              This track
            </button>
            <button
              type="button"
              className={scope === 'all' ? 'is-on' : undefined}
              aria-pressed={scope === 'all'}
              disabled={running}
              onClick={() => setScope('all')}
              title="Every row that has a track, mixed together"
            >
              All four
            </button>
          </div>
        </div>

        <p className="edit-export__summary">{summary}</p>

        <label className="edit-export__field">
          <span className="label">Name</span>
          <input
            ref={nameField}
            className="edit-export__name"
            value={name}
            spellCheck={false}
            disabled={running}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        {phase.kind === 'working' ? (
          <div className="edit-export__status" role="status" aria-live="polite">
            <span>{phase.step}</span>
            {/* Neither the render nor the encode reports how far along it is,
                so the bar sweeps rather than claiming a percentage. */}
            <div className="edit-export__bar" />
            <span className="edit-export__note">A long track takes a while.</span>
          </div>
        ) : null}

        {phase.kind === 'done' ? (
          <div className="edit-export__status is-done" role="status" aria-live="polite">
            <span>Saved</span>
            <span className="edit-export__path mono">{phase.path}</span>
          </div>
        ) : null}

        {phase.kind === 'error' ? (
          <div className="edit-export__status is-error" role="status" aria-live="polite">
            <span>{phase.message}</span>
            {phase.detail ? <span className="edit-export__note">{phase.detail}</span> : null}
          </div>
        ) : null}

        <div className="edit-export__actions">
          {phase.kind === 'done' ? (
            <>
              <button type="button" onClick={() => reveal(phase.path)}>
                Show in Finder
              </button>
              <button type="button" className="edit-export__go" onClick={onClose}>
                Done
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} disabled={running}>
                Cancel
              </button>
              <button
                type="button"
                className="edit-export__go"
                disabled={running || nothingToExport}
                onClick={() => {
                  void start()
                }}
              >
                {running ? 'Exporting…' : 'Export'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * The editing view: the four decks stacked as rows, for building an edit.
 *
 * Every row is a full deck, not a preview — the same store, the same engine,
 * the same key map. Stacking them is what makes an edit readable: four
 * playheads at the same horizontal centre, so the same pixel is "now" on all
 * of them.
 *
 * Exactly one row is focused, and the unshifted keys act on it. `Tab` and
 * `Shift+Tab` walk the four; clicking a row focuses it. The ring itself lives
 * in `useSettings`, so this view holds no state of its own beyond the export
 * panel, which is a thing being done to the rows rather than part of one.
 */
export function EditView(): ReactElement {
  const [exportOpen, setExportOpen] = useState(false)
  const loaded = useExportableDecks()

  return (
    <div className="edit-view">
      <header className="edit-view__bar">
        <button
          type="button"
          className="edit-btn edit-btn--export"
          disabled={loaded.length === 0}
          onClick={() => setExportOpen(true)}
          title={loaded.length === 0 ? 'Load a track first' : 'Save this edit as a file'}
        >
          <span>Export</span>
        </button>
      </header>

      {DECK_IDS.map((id) => (
        <EditTrack key={id} deckId={id} />
      ))}

      {exportOpen ? (
        <ExportPanel loaded={loaded} onClose={() => setExportOpen(false)} />
      ) : null}
    </div>
  )
}

export default EditView
