import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface ModalProps {
  title: string
  onClose(): void
  children: ReactNode
}

/**
 * The one modal shell in the app: backdrop, titled header, close button, and
 * the key handling every dialog needs. Every dialog in the app uses it.
 */
export function Modal({ title, onClose, children }: ModalProps): ReactElement {
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
