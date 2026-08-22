import type { DeckId } from '@shared/types'

/**
 * Where a piece can be dropped, and where a drop is currently aimed.
 *
 * A row's strips are drawn by their own component, so a piece dragged off one
 * row and over another has no way to reach the row underneath the pointer.
 * Every strip that accepts pieces registers itself here; the drag looks up
 * whichever one the pointer is over, and the mark it leaves is read back by
 * that row's own draw loop.
 */

/** A strip a dragged piece can be dropped onto. */
export interface DropZone {
  deck: DeckId
  /** Whatever the row draws on, or the empty panel it shows instead. */
  canvas: HTMLElement
  /** Timeline seconds under a screen x. */
  timeAt(clientX: number): number
}

const zones = new Set<DropZone>()

/** Returns the call that takes the strip back out again. */
export function registerDropZone(zone: DropZone): () => void {
  zones.add(zone)
  return () => {
    zones.delete(zone)
  }
}

/** The strip under the pointer, or null when it is between rows. */
export function zoneAt(clientX: number, clientY: number): DropZone | null {
  for (const zone of zones) {
    const r = zone.canvas.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
      return zone
    }
  }
  return null
}

/** Where a piece dragged in from another row would land. */
export interface DropMark {
  deck: DeckId
  /** Timeline seconds the piece would start at. */
  atSec: number
  /** Place in that row's order. */
  index: number
  /** How long the held piece is, so the row can open room the right size. */
  durationSec: number
  /** The hole it would drop into, when it is landing in empty room. */
  holeId?: string
}

let mark: DropMark | null = null

export function setDropMark(next: DropMark | null): void {
  mark = next
}

export function dropMarkFor(deck: DeckId): DropMark | null {
  return mark && mark.deck === deck ? mark : null
}
