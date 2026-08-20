import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { formatBpm } from '@renderer/core/format'
import { KEYBOARD_SHORTCUTS } from '@renderer/hooks/useKeyboard'
import { useDecks } from '@renderer/state/useDecks'
import { useLibrary } from '@renderer/state/useLibrary'
import { useSettings } from '@renderer/state/useSettings'

/**
 * The rekordbox top strip: mode tabs, the master readouts, the setup guide and
 * the help modal. The strip is drawn in every view — the tabs are how you get
 * back out of one.
 *
 * On macOS the window is `hiddenInset`, so this bar is also the title bar —
 * it carries the drag region and the traffic-light inset that app.css adds.
 */

const EXPORT_DISABLED_TITLE =
  'EXPORT mode is not implemented yet — playlist export and track rendering are future work.'

/** One short line each: this list is read by a dyslexic user. */
const SETUP_STEPS = [
  'Open rekordbox.',
  'Open Preferences.',
  'Go to Advanced, then Other.',
  'Find the Auto Export setting.',
  'Turn it on.',
  'Quit rekordbox. It writes the file on quit.',
  'Back in DJDaw: sidebar, then rekordbox, then Choose XML…',
  'Pick the file rekordbox just wrote.'
]

/**
 * Effective tempo of the focused deck: the grid's tempo scaled by the tempo
 * fader, which is the number a DJ beatmatches against. The first anchor is the
 * right one to read: a variable-tempo grid still opens at its base tempo, and
 * following the playhead would put a 60 Hz value into React state.
 */
function useMasterBpm(): number | null {
  const focused = useSettings((s) => s.focusedDeck)
  const deck = useDecks((s) => s.decks[focused])
  const track = useLibrary((s) => (deck.trackId ? s.trackById(deck.trackId) : undefined))
  const base = track?.grid?.anchors[0]?.bpm ?? track?.bpm ?? null
  return base == null ? null : base * (1 + deck.pitchPercent / 100)
}

interface ModalProps {
  title: string
  onClose(): void
  children: ReactNode
}

/**
 * The one modal shell in the app: backdrop, titled header, close button, and
 * the key handling every dialog here needs. Both toolbar dialogs use it.
 */
function Modal({ title, onClose, children }: ModalProps): ReactElement {
  const dialog = useRef<HTMLDivElement | null>(null)

  // Focus the dialog so the global key map stops seeing keystrokes: the
  // handler below swallows them before they reach the window listener, which
  // is what keeps "1" from firing a hot cue while a dialog is open.
  useEffect(() => {
    dialog.current?.focus()
  }, [])

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      event.stopPropagation()
      if (event.key === 'Escape') onClose()
    },
    [onClose]
  )

  return createPortal(
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={dialog}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <h2 className="modal__title">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body
  )
}

function ShortcutsModal({ onClose }: { onClose(): void }): ReactElement {
  return (
    <Modal title="Keyboard Shortcuts" onClose={onClose}>
      <p className="modal__note">
        Unshifted keys act on the focused deck. <kbd>Tab</kbd> switches which deck that is; text fields swallow
        every binding while they hold focus.
      </p>
      <table className="modal__keys">
        <tbody>
          {KEYBOARD_SHORTCUTS.map((shortcut) => (
            <tr key={shortcut.keys}>
              <th scope="row">
                <kbd>{shortcut.keys}</kbd>
              </th>
              <td>{shortcut.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  )
}

function SetupModal({ onClose }: { onClose(): void }): ReactElement {
  return (
    <Modal title="Set Up Auto Export" onClose={onClose}>
      <p className="modal__note">rekordbox can write its XML file for you. Then DJDaw reads it.</p>

      <ol className="modal__steps">
        {SETUP_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <p className="modal__why">
        <b>Why the quit step?</b> rekordbox only writes the file when it closes. So DJDaw sees your changes after
        you quit rekordbox.
      </p>

      <ul className="modal__caveats">
        <li>The setting may live somewhere else in your version. Look for the words Auto Export.</li>
        <li>rekordbox mentions Dropbox in its own wording. We have not confirmed whether any other folder works.</li>
        <li>If it only offers Dropbox, point DJDaw at the file inside your Dropbox folder.</li>
      </ul>
    </Modal>
  )
}

export function Toolbar(): ReactElement {
  const masterVolume = useSettings((s) => s.masterVolume)
  const setMasterVolume = useSettings((s) => s.setMasterVolume)
  const focused = useSettings((s) => s.focusedDeck)
  const view = useSettings((s) => s.view)
  const setView = useSettings((s) => s.setView)
  const bpm = useMasterBpm()
  const [helpOpen, setHelpOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)

  return (
    <header className="toolbar">
      <div className="toolbar__brand">
        DJ<span>Daw</span>
      </div>

      <div className="toolbar__tabs" role="tablist" aria-label="Mode">
        <button type="button" role="tab" aria-selected="false" disabled title={EXPORT_DISABLED_TITLE}>
          EXPORT
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'performance'}
          className={view === 'performance' ? 'active' : undefined}
          onClick={() => setView('performance')}
        >
          PERFORMANCE
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'edit'}
          className={view === 'edit' ? 'active' : undefined}
          title="Four tracks stacked, for building an edit"
          onClick={() => setView('edit')}
        >
          EDIT
        </button>
      </div>

      <div className="toolbar__spacer" />

      <div className="toolbar__readout" title={`Tempo of the focused deck (${focused}), tempo fader included`}>
        <span className="label">Master BPM</span>
        <span className="mono toolbar__bpm" data-deck={focused}>
          {formatBpm(bpm)}
        </span>
      </div>

      <label className="toolbar__volume">
        <span className="label">Master</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={masterVolume}
          aria-label="Master volume"
          onChange={(event) => setMasterVolume(Number(event.target.value))}
        />
        <span className="mono toolbar__volume-value">{Math.round(masterVolume * 100)}</span>
      </label>

      <button
        type="button"
        className="toolbar__setup"
        title="How to make rekordbox export its XML on its own"
        aria-haspopup="dialog"
        onClick={() => setSetupOpen(true)}
      >
        SETUP
      </button>

      <button
        type="button"
        className="toolbar__help"
        title="Keyboard shortcuts"
        aria-haspopup="dialog"
        onClick={() => setHelpOpen(true)}
      >
        ?
      </button>

      {setupOpen && <SetupModal onClose={() => setSetupOpen(false)} />}
      {helpOpen && <ShortcutsModal onClose={() => setHelpOpen(false)} />}
    </header>
  )
}
