import { useCallback, useEffect, useRef } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement
} from 'react'
import type { DeckId, HotCue } from '@shared/types'
import { AudioEngine } from '@renderer/audio/AudioEngine'
import { bpmAt } from '@renderer/core/beatgrid'
import { BEAT_JUMP_SIZES, HOT_CUE_COUNT, HOT_CUE_LABELS, LOOP_SIZES } from '@renderer/core/constants'
import { clamp, formatBeats, formatBpm, formatTime } from '@renderer/core/format'
import { useRaf } from '@renderer/hooks/useRaf'
import { useDecks } from '@renderer/state/useDecks'
import { useLibrary } from '@renderer/state/useLibrary'

export interface PadSectionProps {
  deckId: DeckId
}

/** Matches the `,` / `.` keyboard nudge, which is what most edits use. */
const GRID_NUDGE_BEATS = 1 / 32

const PAD_INDICES = Array.from({ length: HOT_CUE_COUNT }, (_, i) => i)

/**
 * The pointer holding a pad down, and which pad it is holding.
 *
 * A press and its release are one gesture, so only the pointer that started it
 * may end it: a second finger landing on another pad must not release the
 * first one's preview, and a stray release from a pointer that never pressed
 * must not release anything at all.
 */
interface HeldPad {
  pointerId: number
  index: number
}

/** Buttons that keep focus swallow the Space shortcut. */
function preventFocus(e: ReactMouseEvent<HTMLElement>): void {
  e.preventDefault()
}

/**
 * A hot cue colour at reduced opacity. The pads are tinted rather than filled
 * so the colour reads as a cue marker and not as a lit button.
 */
function tint(hex: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/**
 * Halve or double a size, staying inside the offered range. Both lists are
 * powers of two, so this lands on a listed size; it is the same arithmetic
 * the keyboard's `Shift+Q` / `Shift+W` and `[` / `]` use.
 */
function scaleSize(current: number, factor: number, sizes: readonly number[]): number {
  return clamp(current * factor, sizes[0], sizes[sizes.length - 1])
}

/**
 * Bounds on a hand-typed tempo. Anything outside is a typo rather than a
 * tempo, and writing it to the grid would put every beat in the wrong place.
 */
const MIN_GRID_BPM = 20
const MAX_GRID_BPM = 400

/** One stepper click, matching the two decimals the field shows. */
const BPM_STEP = 0.01

/**
 * The grid tempo under the playhead, or null when there is none to show.
 *
 * Read live instead of from React state because a grid can carry several tempo
 * anchors — a rekordbox import often does — and `setGridBpm` edits the one the
 * playhead sits in. Showing `anchors[0]` would let the field disagree with
 * what an edit is about to change.
 */
function gridBpmAtPlayhead(deckId: DeckId): number | null {
  const state = useDecks.getState().decks[deckId]
  if (state.status !== 'ready' || !state.trackId) return null
  const grid = useLibrary.getState().trackById(state.trackId)?.grid
  if (!grid) return null
  return bpmAt(grid, AudioEngine.shared().deck(deckId).positionSeconds())
}

interface BpmFieldProps {
  deckId: DeckId
  /** False when there is no track or no grid to edit. */
  enabled: boolean
  title: string
}

/**
 * The grid tempo, as a number you can type over.
 *
 * The readout is written straight into the input from a rAF loop, the way the
 * deck header's clocks are: the value follows the playhead across tempo
 * changes without re-rendering the deck sixty times a second. While the field
 * has focus the loop leaves it alone, so it never overwrites what is being
 * typed.
 *
 * The input is deliberately a text input. `hooks/useKeyboard.ts` treats any
 * input that is not a slider or a button as something the user is typing into
 * and drops the global shortcuts for it, so typing `1` here sets a tempo
 * rather than firing hot cue A.
 */
function BpmField({ deckId, enabled, title }: BpmFieldProps): ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null)
  // The last tempo actually on the grid: what a rejected edit reverts to, and
  // what the steppers step from.
  const currentRef = useRef<number | null>(null)
  // Escape and a committed Enter both blur, and the blur must not commit again.
  const skipBlurRef = useRef(false)

  const show = useCallback((bpm: number | null): void => {
    const el = inputRef.current
    if (!el) return
    const text = formatBpm(bpm)
    if (el.value !== text) el.value = text
  }, [])

  useRaf(() => {
    const bpm = gridBpmAtPlayhead(deckId)
    currentRef.current = bpm
    if (inputRef.current !== document.activeElement) show(bpm)
  }, enabled)

  // With the loop stopped the field would keep whatever the last frame wrote.
  useEffect(() => {
    if (enabled) return
    currentRef.current = null
    show(null)
  }, [enabled, show])

  const commit = (): void => {
    const el = inputRef.current
    if (!el) return
    const value = Number(el.value.trim())
    if (!isFinite(value) || value < MIN_GRID_BPM || value > MAX_GRID_BPM) {
      show(currentRef.current)
      return
    }
    // A blur with nothing changed is the common case; skip the grid write so
    // it cannot fork a mirrored track for no reason.
    if (currentRef.current != null && Math.abs(value - currentRef.current) < 1e-9) {
      show(currentRef.current)
      return
    }
    useDecks.getState().setGridBpm(deckId, value)
    currentRef.current = value
    show(value)
  }

  const step = (delta: number): void => {
    const base = currentRef.current
    if (base == null) return
    const next = Math.round((base + delta) * 100) / 100
    if (next < MIN_GRID_BPM || next > MAX_GRID_BPM) return
    useDecks.getState().setGridBpm(deckId, next)
    currentRef.current = next
    show(next)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      skipBlurRef.current = true
      commit()
      e.currentTarget.blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      skipBlurRef.current = true
      show(currentRef.current)
      e.currentTarget.blur()
    }
  }

  const onBlur = (): void => {
    if (skipBlurRef.current) {
      skipBlurRef.current = false
      return
    }
    commit()
  }

  return (
    <span className={`bpm-field${enabled ? '' : ' is-disabled'}`} title={title}>
      <span className="bpm-tag">BPM</span>
      <input
        ref={inputRef}
        type="text"
        className="bpm-input mono"
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        aria-label="Grid BPM"
        disabled={!enabled}
        defaultValue={formatBpm(null)}
        // The pad section kills focus on mousedown so buttons cannot swallow
        // Space. This field is the one thing in it that needs the focus.
        onMouseDown={(e) => e.stopPropagation()}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      <span className="bpm-steppers">
        <button type="button" className="bpm-step" disabled={!enabled} onClick={() => step(BPM_STEP)} title="Up 0.01">
          &#9650;
        </button>
        <button
          type="button"
          className="bpm-step"
          disabled={!enabled}
          onClick={() => step(-BPM_STEP)}
          title="Down 0.01"
        >
          &#9660;
        </button>
      </span>
    </span>
  )
}

/**
 * Hot cues, beat jump, loop and grid editing: the block that turns the deck
 * into an edit surface rather than a player.
 */
export function PadSection({ deckId }: PadSectionProps): ReactElement {
  const deck = useDecks((s) => s.decks[deckId])
  const track = useLibrary((s) => (deck.trackId ? s.trackById(deck.trackId) : undefined))

  // Keyed by pointerId: two fingers can hold two pads, each with its own release.
  const held = useRef(new Map<number, HeldPad>())

  const ready = deck.status === 'ready'
  const hasGrid = ready && track?.grid != null
  const cues = track?.hotCues ?? []
  const loopActive = deck.loop?.active === true
  const bpmTitle = !ready
    ? 'Load a track first'
    : !hasGrid
      ? 'No beat grid yet. Tap the tempo first.'
      : 'Grid BPM. Click to type a new one. Enter to apply, Escape to cancel.'

  // A pad that stops taking pointer events mid-hold — the deck ejected, so
  // every pad went disabled — takes its release with it. Nothing else would
  // ever end that preview, so end it here.
  useEffect(() => {
    if (ready || held.current.size === 0) return
    held.current.clear()
    useDecks.getState().endPreview(deckId)
  }, [ready, deckId])

  // Same for a pad unmounted mid-hold: an unmounted element never sees its own
  // pointerup, and a stuck preview outlives the component that started it.
  useEffect(
    () => () => {
      if (held.current.size === 0) return
      held.current.clear()
      useDecks.getState().endPreview(deckId)
    },
    [deckId]
  )

  const onPadDown = (e: ReactPointerEvent<HTMLButtonElement>, index: number, cue: HotCue | undefined): void => {
    if (e.button !== 0) return
    if (e.shiftKey) {
      // A delete is over the instant it happens; there is no hold to track.
      if (cue) useDecks.getState().deleteHotCue(deckId, index)
      return
    }
    // Capture before the trigger. Without it the release only arrives while
    // the pointer is still over the pad, and a release a few pixels away
    // leaves the preview running until the track hits its end.
    e.currentTarget.setPointerCapture(e.pointerId)
    held.current.set(e.pointerId, { pointerId: e.pointerId, index })
    useDecks.getState().triggerHotCue(deckId, index)
  }

  // pointerup, pointercancel and lostpointercapture all mean the same thing
  // here: the hold is over. Capture makes the first two land on the pad
  // wherever the pointer has wandered to, and the third catches the releases
  // that never fire as either — a capture torn away by the browser, say.
  // Whichever arrives first clears the ref, so the rest are no-ops.
  const onPadEnd = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const hold = held.current.get(e.pointerId)
    if (!hold) return
    held.current.delete(e.pointerId)
    useDecks.getState().releaseHotCue(deckId, hold.index)
  }

  const jump = (beats: number): void => useDecks.getState().beatJump(deckId, beats)
  const jumpSize = (factor: number): void =>
    useDecks.getState().setBeatJumpBeats(deckId, scaleSize(deck.beatJumpBeats, factor, BEAT_JUMP_SIZES))
  const loopSize = (factor: number): void =>
    useDecks.getState().setLoopBeats(deckId, scaleSize(deck.loopBeats, factor, LOOP_SIZES))

  return (
    <div className="pads" onMouseDown={preventFocus}>
      <div className="pad-grid">
        {PAD_INDICES.map((index) => {
          const cue = cues.find((c) => c.index === index)
          const label = HOT_CUE_LABELS[index]
          return (
            <button
              type="button"
              key={index}
              className={`pad${cue ? ' is-set' : ''}`}
              style={cue ? { background: tint(cue.color, 0.3), borderColor: tint(cue.color, 0.9) } : undefined}
              disabled={!ready}
              onPointerDown={(e) => onPadDown(e, index, cue)}
              onPointerUp={onPadEnd}
              onPointerCancel={onPadEnd}
              onLostPointerCapture={onPadEnd}
              title={
                cue
                  ? `Hot cue ${label} at ${formatTime(cue.time)} — hold to preview, shift-click to delete (${index + 1})`
                  : `Set hot cue ${label} here (${index + 1})`
              }
            >
              <span className="pad-letter">{label}</span>
              <span className="pad-time mono">{cue ? formatTime(cue.time, false) : ''}</span>
            </button>
          )
        })}
      </div>

      <div className="deck-row">
        <span className="label deck-row-label">Beat Jump</span>
        <button type="button" disabled={!ready} onClick={() => jumpSize(0.5)} title="Halve the jump size">
          ÷2
        </button>
        <span className="size-readout mono">{formatBeats(deck.beatJumpBeats)}</span>
        <button type="button" disabled={!ready} onClick={() => jumpSize(2)} title="Double the jump size">
          x2
        </button>
        <button
          type="button"
          className="jump-btn"
          disabled={!ready}
          onClick={() => jump(-deck.beatJumpBeats)}
          title={`Jump back ${formatBeats(deck.beatJumpBeats)} beats`}
        >
          <span className="jump-arrow">&#9664;</span>
          <span>{formatBeats(deck.beatJumpBeats)}</span>
          <kbd>Q</kbd>
        </button>
        <button
          type="button"
          className="jump-btn"
          disabled={!ready}
          onClick={() => jump(deck.beatJumpBeats)}
          title={`Jump forward ${formatBeats(deck.beatJumpBeats)} beats`}
        >
          <kbd>W</kbd>
          <span>{formatBeats(deck.beatJumpBeats)}</span>
          <span className="jump-arrow">&#9654;</span>
        </button>
      </div>

      <div className="deck-row">
        <span className="label deck-row-label">Loop</span>
        <button type="button" disabled={!ready} onClick={() => loopSize(0.5)} title="Halve the loop length">
          ÷2
        </button>
        <span className="size-readout mono">{formatBeats(deck.loopBeats)}</span>
        <button type="button" disabled={!ready} onClick={() => loopSize(2)} title="Double the loop length">
          x2
        </button>
        <button
          type="button"
          className={`loop-btn${loopActive ? ' active' : ''}`}
          disabled={!ready}
          onClick={() => useDecks.getState().toggleLoop(deckId)}
          title="Loop in at the playhead for the length shown (L)"
        >
          Loop
        </button>
      </div>

      <div className="deck-row deck-row-grid">
        <span className="label deck-row-label">Grid</span>
        <button
          type="button"
          className={deck.quantize ? 'active' : undefined}
          disabled={!ready}
          onClick={() => useDecks.getState().toggleQuantize(deckId)}
          title="Snap cues, loops and jumps to the beat (Y)"
        >
          Quantize
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={() => useDecks.getState().tapTempo(deckId)}
          title="Tap the tempo (T)"
        >
          Tap
        </button>
        <BpmField deckId={deckId} enabled={hasGrid} title={bpmTitle} />
        <button
          type="button"
          disabled={!hasGrid}
          onClick={() => useDecks.getState().setDownbeatHere(deckId)}
          title="Move the nearest downbeat to the playhead (G)"
        >
          Set Downbeat
        </button>
        <button
          type="button"
          disabled={!hasGrid}
          onClick={() => useDecks.getState().nudgeGrid(deckId, -GRID_NUDGE_BEATS)}
          title="Nudge the grid back 1/32 beat (,)"
        >
          &lt;
        </button>
        <button
          type="button"
          disabled={!hasGrid}
          onClick={() => useDecks.getState().nudgeGrid(deckId, GRID_NUDGE_BEATS)}
          title="Nudge the grid forward 1/32 beat (.)"
        >
          &gt;
        </button>
        <button
          type="button"
          disabled={!hasGrid}
          onClick={() => useDecks.getState().scaleGrid(deckId, 2)}
          title="Double the grid BPM"
        >
          x2
        </button>
        <button
          type="button"
          disabled={!hasGrid}
          onClick={() => useDecks.getState().scaleGrid(deckId, 0.5)}
          title="Halve the grid BPM"
        >
          ÷2
        </button>
      </div>
    </div>
  )
}
