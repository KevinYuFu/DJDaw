/**
 * What a drag out of the browser carries: the id of the track being dragged.
 *
 * A private type, so a drop target can tell it from a file dragged in off the
 * desktop.
 */
export const TRACK_DRAG_MIME = 'application/x-djdaw-track'

/**
 * The track currently being dragged, or null.
 *
 * `dataTransfer` only yields its data on the drop; during the drag a target can
 * read the type but not the id. This holds the id for the length of the drag.
 */
let dragging: string | null = null

export function beginTrackDrag(trackId: string): void {
  dragging = trackId
}

export function endTrackDrag(): void {
  dragging = null
}

export function draggedTrackId(): string | null {
  return dragging
}
