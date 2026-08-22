/**
 * The round bracket shown on a clip's edge.
 *
 * A bracket rather than a plain resize arrow because the edge is a window onto
 * the file, not a handle that stretches it: pulling it out gives back audio
 * that was trimmed, and the bracket is the shape of the edge being moved.
 */

/** How close to an edge, in pixels, counts as being on it. */
export const EDGE_GRAB_PX = 6

function bracket(d: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="24" viewBox="0 0 18 24">` +
    `<path d="${d}" fill="none" stroke="black" stroke-width="4.5" stroke-linecap="round"/>` +
    `<path d="${d}" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"/>` +
    `</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 9 12, ew-resize`
}

/** The clip's left edge: a bracket opening to the right. */
export const CURSOR_START_EDGE = bracket('M12 3 Q6 12 12 21')

/** The clip's right edge: a bracket opening to the left. */
export const CURSOR_END_EDGE = bracket('M6 3 Q12 12 6 21')

/** Which edge a pointer is on, if either. */
export function edgeAt(xPx: number, startPx: number, endPx: number): 'start' | 'end' | null {
  if (Math.abs(xPx - startPx) <= EDGE_GRAB_PX) return 'start'
  if (Math.abs(xPx - endPx) <= EDGE_GRAB_PX) return 'end'
  return null
}
