/**
 * What a drag out of the browser carries: the id of the track being dragged.
 *
 * A private type rather than `text/plain`, so a drop target can tell one of
 * these from a file dragged in off the desktop.
 */
export const TRACK_DRAG_MIME = 'application/x-djdaw-track'

/**
 * The track currently being dragged, or null.
 *
 * `dataTransfer` only hands its data back on the drop itself — during the drag
 * a target can see the type but not the id. A drop target that has to draw
 * what it is about to receive needs the id the whole way, so it is kept here
 * as well for the length of the drag.
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
