/** Which edge of a clip the pointer is on. */
import { CURSOR_END_EDGE, CURSOR_START_EDGE, EDGE_GRAB_PX, edgeAt } from './.build/clipCursor.mjs'

const { eq, ok } = globalThis.__t

eq('right on the left edge', edgeAt(100, 100, 300), 'start')
eq('within reach of it', edgeAt(100 + EDGE_GRAB_PX, 100, 300), 'start')
eq('just past reach is the body', edgeAt(100 + EDGE_GRAB_PX + 1, 100, 300), null)
eq('right on the right edge', edgeAt(300, 100, 300), 'end')
eq('within reach of that one', edgeAt(300 - EDGE_GRAB_PX, 100, 300), 'end')
eq('the middle is the body', edgeAt(200, 100, 300), null)
eq('on a very short clip the left edge wins', edgeAt(101, 100, 103), 'start')

ok('the cursors are bracket drawings', CURSOR_START_EDGE.startsWith('url("data:image/svg+xml,'))
ok('and they fall back to a resize arrow', CURSOR_END_EDGE.endsWith('ew-resize'))
ok('the two point opposite ways', CURSOR_START_EDGE !== CURSOR_END_EDGE)
