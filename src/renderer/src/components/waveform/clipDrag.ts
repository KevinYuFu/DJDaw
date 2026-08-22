import type { Clip } from '@shared/clips'
import { clipAt, deleteSegment, dropIndex, fillStartSec, layOut } from '@shared/clips'
import type { DeckId } from '@shared/types'
import { openGap } from './clipSlide'

/**
 * The piece being carried, and where it would land if it were let go now.
 *
 * One drag at a time, held here rather than in a component, because every row
 * has to answer the same question about it: what would I look like if this
 * landed on me. Rows read it in their draw loops and the ghost follows the
 * hand, so a piece behaves the same whether it is going back into its own row
 * or onto another one.
 */
export interface ClipDrag {
  /** The row it was picked up from. */
  fromDeck: DeckId
  clip: Clip
  /** The row under the hand, or null when it is over none of them. */
  toDeck: DeckId | null
  /** Place in that row's order, counted with the piece already out of it. */
  index: number
  /** The hole it would land in, when it is landing in empty room. */
  holeId: string | null
  /** Timeline seconds it would start at. */
  atSec: number
  /** Where the ghost sits, and the size it was lifted at. */
  x: number
  y: number
  width: number
  height: number
}

let drag: ClipDrag | null = null
const listeners = new Set<(drag: ClipDrag | null) => void>()

export function setClipDrag(next: ClipDrag | null): void {
  drag = next
  for (const listen of listeners) listen(drag)
}

export function clipDrag(): ClipDrag | null {
  return drag
}

/** Returns the call that stops listening. */
export function subscribeClipDrag(listen: (drag: ClipDrag | null) => void): () => void {
  listeners.add(listen)
  return () => {
    listeners.delete(listen)
  }
}

/**
 * The row as it would be if the piece were let go now.
 *
 * Rows draw this rather than what they hold, so what the drop will do is on
 * screen before it happens and nothing is written until the hand opens.
 */
function rowUnderDrag(deck: DeckId, clips: readonly Clip[]): readonly Clip[] {
  if (!drag) return clips
  const from = deck === drag.fromDeck
  const to = deck === drag.toDeck
  if (!from && !to) return clips

  // Back into its own row: it is out of the row, and room is open where it
  // would go — which is what a reorder looks like.
  if (from && to) {
    const rest = layOut(clips.filter((clip) => clip.id !== drag!.clip.id))
    return drag.holeId ? rest : openGap(rest, drag.index, drag.clip.durationSec)
  }
  // On its way out, leaving empty room behind it.
  if (from) return deleteSegment(clips, drag.clip.id).clips
  return drag.holeId ? clips : openGap(clips, drag.index, drag.clip.durationSec)
}

/** What a row last drew, so it is worked out again only when it changes. */
export interface DragRowMemo {
  clips: readonly Clip[] | null
  key: string
  row: readonly Clip[]
}

export function newDragRowMemo(): DragRowMemo {
  return { clips: null, key: '', row: [] }
}

/** How the drag reads to one row, ignoring where the ghost happens to be. */
function layoutKey(deck: DeckId): string {
  if (!drag) return ''
  if (deck !== drag.fromDeck && deck !== drag.toDeck) return ''
  return `${drag.fromDeck}|${drag.toDeck}|${drag.clip.id}|${drag.index}|${drag.holeId}|${drag.clip.durationSec}`
}

/**
 * The row a drag would leave, held steady between changes.
 *
 * The same array comes back until the drag moves somewhere that changes the
 * row, so whatever draws from it can tell one frame from the next by identity.
 */
export function rowForDrag(
  memo: DragRowMemo,
  deck: DeckId,
  clips: readonly Clip[]
): readonly Clip[] {
  const key = layoutKey(deck)
  if (memo.clips === clips && memo.key === key) return memo.row
  memo.clips = clips
  memo.key = key
  memo.row = key === '' ? clips : rowUnderDrag(deck, clips)
  return memo.row
}

/** Where a piece let go at `atSec` would land in a row it is not part of. */
export interface ClipAim {
  /** Place in the row's order. */
  index: number
  /** The hole it lands in, when it is landing in empty room. */
  holeId: string | null
  /** Timeline seconds it would start at. */
  atSec: number
}

/**
 * Where a held piece would land in a row.
 *
 * A row of pieces takes it between two of them, at whichever seam is nearest.
 * Empty room takes it where it was let go and is cut around it. `clips` must
 * already have the held piece out of it, so dropping a piece back into its own
 * row is the same question as dropping it into any other.
 */
export function aimInRow(clips: readonly Clip[], held: Clip, at: number): ClipAim {
  const under = clipAt(clips, at)
  if (under && under.silent && under.durationSec >= held.durationSec) {
    return { index: 0, holeId: under.id, atSec: fillStartSec(under, at, held.durationSec) }
  }
  const index = dropIndex(clips, held.id, at)
  let atSec = 0
  for (let i = 0; i < index; i++) atSec += clips[i].durationSec
  return { index, holeId: null, atSec }
}

/** A row with the held piece taken out of it, which is what a drop aims into. */
export function rowWithout(clips: readonly Clip[], clipId: string): readonly Clip[] {
  return layOut(clips.filter((clip) => clip.id !== clipId))
}

/** Where the line marking the drop goes on a row, or null when it takes none. */
export function dropLineFor(deck: DeckId): number | null {
  return drag && drag.toDeck === deck ? drag.atSec : null
}
