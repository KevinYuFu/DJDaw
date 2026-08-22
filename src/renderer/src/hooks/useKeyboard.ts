import { useEffect } from 'react'
import { DECK_IDS } from '@shared/types'
import type { DeckId } from '@shared/types'
import { BEAT_JUMP_SIZES, HOT_CUE_COUNT, LOOP_SIZES } from '@renderer/core/constants'
import { clamp } from '@renderer/core/format'
import { useDecks } from '@renderer/state/useDecks'
import { useLibrary } from '@renderer/state/useLibrary'
import { useArrangement } from '@renderer/state/useArrangement'
import { useSettings } from '@renderer/state/useSettings'

/**
 * The keyboard layer: the app's hardware surface when there is no CDJ plugged
 * in. Every binding acts on the focused deck (`Tab` moves the focus) and is
 * dispatched from a single window-level listener that reads the stores with
 * `getState()`, so the handler is installed once and can never go stale.
 *
 * The transport map is the same in both views. What changes is how many decks
 * `Tab` walks: the ring is owned by `useSettings.cycleFocusedDeck`, which knows
 * the performance view draws two decks and the editing view four, so nothing
 * here has to branch on the view.
 *
 * The clip keys — cut and delete — are the exception. They only exist in the
 * editing view, because the performance view draws no clips to act on. There
 * they are fully inert: not handled, not swallowed, so `Backspace` still means
 * whatever the browser thinks it means.
 *
 * Bindings are matched on `event.code`, not `event.key`, for two reasons: the
 * map is positional the way a controller is, and `Shift+1` reports a key of
 * `'!'` on a US layout and something else again on every other layout, while
 * the code stays `Digit1`.
 */

/** The grid nudge step, matching rekordbox's fine alignment buttons. */
const GRID_NUDGE_BEATS = 1 / 32

/** One row of the help modal. Kept next to the bindings so they cannot drift. */
export interface ShortcutHelp {
  keys: string
  action: string
}

/** The key map as shown to the user, in the order docs/ARCHITECTURE.md lists it. */
export const KEYBOARD_SHORTCUTS: readonly ShortcutHelp[] = [
  { keys: 'Space', action: 'Play / pause the focused deck' },
  { keys: 'Q / W', action: 'Beat jump back / forward (16 beats by default)' },
  { keys: 'Shift + Q / W', action: 'Halve / double the beat-jump size' },
  { keys: '1 – 8', action: 'Hot cue A–H: set if empty, jump if set, hold to preview' },
  { keys: 'Shift + 1 – 8', action: 'Delete hot cue A–H' },
  { keys: 'Z', action: 'CUE — back to cue, or hold to preview from it' },
  { keys: 'X', action: 'Drop a locator at the playhead' },
  { keys: 'C', action: 'Delete the locator at the playhead' },
  { keys: 'D / F', action: 'Jump to the next / previous cue or locator' },
  { keys: 'L', action: 'Toggle the loop' },
  { keys: '[ / ]', action: 'Loop length halve / double' },
  { keys: ', / .', action: 'Nudge the beat grid back / forward 1/32 beat' },
  { keys: 'G', action: 'Set the downbeat at the playhead' },
  { keys: 'T', action: 'Tap tempo' },
  { keys: 'Y', action: 'Toggle quantize' },
  { keys: '- / =', action: 'Waveform zoom out / in' },
  { keys: '← / →', action: 'Nudge the playhead by one beat' },
  { keys: 'A', action: 'Load the track picked in the browser into the focused deck' },
  { keys: 'Tab', action: 'Move the focus to the next deck' },
  { keys: 'Shift + Tab', action: 'Move the focus back one deck' },
  { keys: 'Cmd / Ctrl + E', action: 'Edit view: cut the track at the playhead' },
  { keys: '↑ / ↓', action: 'Edit V2: move the picked track up or down' },
  { keys: 'Delete', action: 'Edit V2: delete the picked track' },
  { keys: 'Delete', action: 'Edit view: delete the picked clip, leaving a gap' },
  { keys: 'Shift + Delete', action: 'Edit view: delete it and close the gap' }
] as const

/**
 * Whether a key event belongs to something the user is typing into. Range
 * sliders, checkboxes and buttons are explicitly not text: they ignore the
 * letter keys anyway, and swallowing shortcuts because the master volume
 * happens to hold focus would be maddening. The arrows are the exception —
 * see {@link consumesArrowKeys}.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  'range',
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'color',
  'file',
  'image'
])

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(target.type)
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}

/**
 * Input types that act on the arrow keys themselves. They are not text, so the
 * letter bindings still reach the decks while one holds focus — but a range
 * slider whose arrows nudge the playhead instead of its own value is a control
 * the keyboard cannot work, which is what the master volume was.
 */
const ARROW_CONSUMING_INPUT_TYPES = new Set([
  'range',
  'number',
  'radio',
  'date',
  'time',
  'datetime-local',
  'month',
  'week'
])

/** Codes a focused form control is entitled to keep for itself. */
const ARROW_CODES = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

function consumesArrowKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLInputElement) return ARROW_CONSUMING_INPUT_TYPES.has(target.type)
  // Custom controls that claim the role claim its key handling with it.
  const role = target.getAttribute('role')
  return role === 'slider' || role === 'spinbutton'
}

/** `Digit1`–`Digit8` and the numpad equivalents map to hot cue pads A–H. */
function hotCueIndex(code: string): number | null {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(code)
  if (!match) return null
  const index = Number(match[1]) - 1
  return index >= 0 && index < HOT_CUE_COUNT ? index : null
}

function focusedDeck(): DeckId {
  return useSettings.getState().focusedDeck
}

/** Whether the editing view is on screen, which is the only place clips exist. */
function inEditView(): boolean {
  return useSettings.getState().view === 'edit'
}

/** The arrangement view holds no decks, so no deck binding fires behind it. */
function inArrangementView(): boolean {
  return useSettings.getState().view === 'arrangement'
}

/**
 * `Cmd+E` / `Ctrl+E` — cut the focused row in two at the playhead, the way
 * Ableton does. Kevin is on a Mac and will reach for Cmd; Ctrl is here so the
 * binding is the same on every platform.
 *
 * A refused cut — nothing loaded, or the playhead sitting on a clip edge — is
 * not worth interrupting anyone for. The Cut button is where a reason belongs;
 * from the keyboard it only goes to the log.
 */
function cutAtPlayhead(deck: DeckId): void {
  const result = useDecks.getState().cutAtPlayhead(deck)
  if (!result.ok) console.debug('[keyboard] cut refused', result.reason)
}

/** Halve or double a size, staying inside the offered range. */
function scaleSize(current: number, factor: number, sizes: readonly number[]): number {
  return clamp(current * factor, sizes[0], sizes[sizes.length - 1])
}

function stepBeatJumpSize(deck: DeckId, factor: number): void {
  const { decks, setBeatJumpBeats } = useDecks.getState()
  setBeatJumpBeats(deck, scaleSize(decks[deck].beatJumpBeats, factor, BEAT_JUMP_SIZES))
}

function stepLoopSize(deck: DeckId, factor: number): void {
  const { decks, setLoopBeats } = useDecks.getState()
  setLoopBeats(deck, scaleSize(decks[deck].loopBeats, factor, LOOP_SIZES))
}

/**
 * Zoom levels are seconds of audio across the width of the detailed waveform,
 * so zooming *in* means a *lower* index.
 */
function stepZoom(deck: DeckId, delta: number): void {
  const { decks, setZoom } = useDecks.getState()
  setZoom(deck, decks[deck].zoomIndex + delta)
}

/**
 * `Q` and `W` jump by the deck's beat-jump size, which starts at
 * DEFAULT_BEAT_JUMP (16) — that is what makes them "back 16" and "forward 16"
 * out of the box, and what gives `Shift+Q` / `Shift+W` something to change.
 */
function beatJump(deck: DeckId, direction: -1 | 1): void {
  const { decks, beatJump: jump } = useDecks.getState()
  jump(deck, direction * decks[deck].beatJumpBeats)
}

/**
 * `A` — load whatever the browser has selected onto a deck. Same path as the
 * browser's own Enter-to-load: the store's `loadTrack` does the decode, the
 * analysis and the deck swap, so the two routes cannot drift apart. With
 * nothing selected there is nothing to load and the press is a no-op.
 */
function loadSelection(deck: DeckId): void {
  const trackId = useLibrary.getState().selectedId
  if (!trackId) return
  void useDecks
    .getState()
    .loadTrack(deck, trackId)
    .catch((err: unknown) => console.error('[keyboard] load failed', err))
}

/**
 * Codes that are safe to auto-repeat: holding them down should keep firing,
 * the way holding a beat-jump button on a controller does. Everything else
 * (transport, pads, toggles) is edge-triggered only.
 */
const REPEATABLE = new Set([
  'KeyQ',
  'KeyW',
  // Held down, these walk forward or back through the markers, which is a
  // reasonable way to find a spot. Dropping and deleting locators are not:
  // held, they would spray markers or clear a run of them.
  'KeyD',
  'KeyF',
  'ArrowLeft',
  'ArrowRight',
  'BracketLeft',
  'BracketRight',
  'Comma',
  'Period',
  'Minus',
  'Equal'
])

/**
 * Whether *this press* may auto-repeat. Shift changes what `Q` and `W` do —
 * from a jump to resizing the jump — and a size is chosen once per press: held
 * down at the repeat rate it would be at the end of BEAT_JUMP_SIZES before the
 * DJ could let go, so the modifier has to be part of the decision, not just
 * the code.
 */
function isRepeatable(event: KeyboardEvent): boolean {
  if (event.shiftKey && (event.code === 'KeyQ' || event.code === 'KeyW')) return false
  return REPEATABLE.has(event.code)
}

/** Whether a code is bound at all, so auto-repeat can be swallowed too. */
function isBound(code: string): boolean {
  if (hotCueIndex(code) !== null) return true
  // Held down in the performance view these are not ours, so they must reach
  // the browser rather than being quietly eaten on every repeat.
  if (code === 'Delete' || code === 'Backspace') return inEditView()
  return (
    REPEATABLE.has(code) ||
    code === 'Space' ||
    code === 'Tab' ||
    code === 'KeyA' ||
    code === 'KeyC' ||
    code === 'KeyX' ||
    code === 'KeyZ' ||
    code === 'KeyL' ||
    code === 'KeyG' ||
    code === 'KeyT' ||
    code === 'KeyY'
  )
}

/**
 * The arrangement view's own keys.
 *
 * Its own because nothing on screen is a deck: the transport, the zoom and
 * delete all belong to the arrangement, and every deck binding is off.
 */
function arrangementKey(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const arrangement = useArrangement.getState()
  switch (event.code) {
    case 'Delete':
    case 'Backspace': {
      const picked = arrangement.selectedTrackId
      if (picked) arrangement.removeTrack(picked)
      break
    }
    case 'ArrowUp':
      arrangement.moveSelectedTrack(-1)
      break
    case 'ArrowDown':
      arrangement.moveSelectedTrack(1)
      break
    case 'Minus':
      arrangement.setZoom(arrangement.zoomIndex - 1)
      break
    case 'Equal':
      arrangement.setZoom(arrangement.zoomIndex + 1)
      break
    default:
      return
  }
  event.preventDefault()
}

/**
 * Install the global key map. Call once, from the app shell.
 *
 * Press-and-hold bindings — the hot cue pads and `Z`, which is CUE — need the
 * keyup as well, so the deck knows to stop previewing. The deck each held key was pressed on
 * is remembered, because `Tab` can move the focus while a pad is down, and the
 * release has to go back to the deck that actually started playing, not to
 * whichever one is focused by the time the DJ lets go.
 *
 * The keyup that never comes is covered too: losing the window mid-hold ends
 * every deck's preview, since a deck left previewing plays on with nothing
 * left to stop it.
 */
export function useKeyboard(): void {
  useEffect(() => {
    const held = new Map<string, DeckId>()

    const releaseHeld = (code: string): void => {
      const deck = held.get(code)
      if (deck === undefined) return
      held.delete(code)
      const decks = useDecks.getState()
      if (code === 'KeyZ') {
        decks.cueRelease(deck)
        return
      }
      const index = hotCueIndex(code)
      if (index !== null) decks.releaseHotCue(deck, index)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return
      if (inArrangementView()) {
        arrangementKey(event)
        return
      }
      // Cut is the one binding that wants a modifier, so it is matched ahead of
      // the guard below, which hands every other Cmd/Ctrl chord to the menu.
      if (event.code === 'KeyE' && (event.metaKey || event.ctrlKey) && !event.altKey) {
        if (!inEditView()) return
        event.preventDefault()
        if (!event.repeat) cutAtPlayhead(focusedDeck())
        return
      }
      // Cmd/Ctrl/Alt combinations belong to the application menu — Cmd+Q must
      // quit rather than beat jump.
      if (event.metaKey || event.ctrlKey || event.altKey) return
      // An arrow belongs to whatever has focus if that thing acts on arrows.
      if (ARROW_CODES.has(event.code) && consumesArrowKeys(event.target)) return
      if (event.repeat && !isRepeatable(event)) {
        // Still swallowed: the browser must not act on the repeat either.
        if (isBound(event.code)) event.preventDefault()
        return
      }

      const deck = focusedDeck()
      const decks = useDecks.getState()
      const shift = event.shiftKey
      let handled = true

      switch (event.code) {
        case 'Space':
          decks.togglePlay(deck)
          break

        case 'Tab':
          // Shift walks the ring backwards. In the performance view both
          // directions are the same A/B swap, so this is unchanged there.
          useSettings.getState().cycleFocusedDeck(shift ? -1 : 1)
          break

        case 'KeyA':
          loadSelection(deck)
          break

        case 'KeyQ':
          if (shift) stepBeatJumpSize(deck, 0.5)
          else beatJump(deck, -1)
          break

        case 'KeyW':
          if (shift) stepBeatJumpSize(deck, 2)
          else beatJump(deck, 1)
          break

        case 'KeyZ':
          decks.cuePress(deck)
          held.set(event.code, deck)
          break

        case 'KeyX':
          decks.addMemoryCue(deck)
          break

        case 'KeyC':
          decks.deleteMemoryCueAt(deck)
          break

        case 'KeyD':
          decks.jumpToPoint(deck, 1)
          break

        case 'KeyF':
          decks.jumpToPoint(deck, -1)
          break

        case 'KeyL':
          decks.toggleLoop(deck)
          break

        case 'BracketLeft':
          stepLoopSize(deck, 0.5)
          break

        case 'BracketRight':
          stepLoopSize(deck, 2)
          break

        case 'Comma':
          decks.nudgeGrid(deck, -GRID_NUDGE_BEATS)
          break

        case 'Period':
          decks.nudgeGrid(deck, GRID_NUDGE_BEATS)
          break

        case 'KeyG':
          decks.setDownbeatHere(deck)
          break

        case 'KeyT':
          decks.tapTempo(deck)
          break

        case 'KeyY':
          decks.toggleQuantize(deck)
          break

        case 'Minus':
          stepZoom(deck, 1)
          break

        case 'Equal':
          stepZoom(deck, -1)
          break

        case 'ArrowLeft':
          decks.beatJump(deck, -1)
          break

        case 'ArrowRight':
          decks.beatJump(deck, 1)
          break

        case 'Delete':
        case 'Backspace':
          // Shift closes the gap the deleted clip leaves; on its own the gap
          // stays and plays as silence.
          if (inEditView()) decks.deleteSelectedClip(deck)
          else handled = false
          break

        default: {
          const index = hotCueIndex(event.code)
          if (index === null) {
            handled = false
            break
          }
          if (shift) {
            decks.deleteHotCue(deck, index)
          } else {
            // Sets the cue when the pad is empty, jumps when it is not, and
            // previews for as long as the key is down on a paused deck.
            decks.triggerHotCue(deck, index)
            held.set(event.code, deck)
          }
          break
        }
      }

      // Space scrolls, Tab walks the focus ring, and both would fight the
      // transport if they reached the browser's defaults.
      if (handled) event.preventDefault()
    }

    const onKeyUp = (event: KeyboardEvent): void => {
      if (!held.has(event.code)) return
      event.preventDefault()
      releaseHeld(event.code)
    }

    // A key held while the window loses focus never sends its keyup, and a
    // preview nothing ever ends is the worst thing this map can do. So blur
    // does not try to work out which keys were down: it drops the map and ends
    // the preview on every deck. `endPreview` is a no-op where there is none.
    const onBlur = (): void => {
      held.clear()
      const decks = useDecks.getState()
      for (const id of DECK_IDS) decks.endPreview(id)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      onBlur()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
}
