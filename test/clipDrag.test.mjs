/**
 * One drag, wherever a piece is carried.
 *
 * A piece always comes out of the order first, so dropping it back into its
 * own row asks exactly the same question as dropping it onto another one, and
 * every row draws what the drop would do before it happens.
 */
import { aimInRow, newDragRowMemo, rowForDrag, rowWithout, setClipDrag } from './.build/clipDrag.mjs'

const { eq, ok } = globalThis.__t

const clip = (id, startSec, durationSec, extra = {}) => ({
  id,
  startSec,
  durationSec,
  sourceOffsetSec: 0,
  ...extra
})
const row = [clip('a', 0, 10), clip('b', 10, 20), clip('c', 30, 10)]
const held = clip('b', 10, 20)

// --- where a drop would land ---------------------------------------------
{
  const rest = rowWithout(row, 'b')
  eq('the held piece is out of the row', rest.length, 2)
  eq('and what is left is closed up', rest[1].startSec, 10)

  eq('before the first piece', aimInRow(rest, held, 1).index, 0)
  eq('past its middle, after it', aimInRow(rest, held, 6).index, 1)
  eq('past the end, last', aimInRow(rest, held, 100).index, 2)
  eq('the line goes on the seam it would go into', aimInRow(rest, held, 6).atSec, 10)
  eq('and no hole is involved', aimInRow(rest, held, 6).holeId, null)
}

// --- empty room takes it where it was let go -----------------------------
{
  const withHole = [clip('a', 0, 10), clip('gap', 10, 40, { silent: true }), clip('c', 50, 10)]
  const aimed = aimInRow(withHole, held, 25)
  eq('a hole takes the piece', aimed.holeId, 'gap')
  eq('where it was let go', aimed.atSec, 25)

  const tooBig = clip('big', 0, 50)
  eq('unless the piece will not fit in it', aimInRow(withHole, tooBig, 25).holeId, null)
}

// --- what each row draws mid-drag ----------------------------------------
{
  const other = [clip('x', 0, 5), clip('y', 5, 5)]

  // Carried onto another row.
  setClipDrag({
    fromDeck: 'A',
    clip: held,
    toDeck: 'B',
    index: 1,
    holeId: null,
    atSec: 5,
    x: 0,
    y: 0,
    width: 0,
    height: 0
  })
  const from = rowForDrag(newDragRowMemo(), 'A', row)
  ok(`the row it left shows empty room where it was — ${JSON.stringify(from.map((c) => [c.startSec, c.durationSec, !!c.silent]))}`,
    from.length === 3 && from[1].silent && from[1].durationSec === 20)
  const to = rowForDrag(newDragRowMemo(), 'B', other)
  eq('the row it is over opens room before the seam', to[0].startSec, 0)
  eq('and pushes everything after it along by the piece', to[1].startSec, 5 + 20)
  eq('a row it is nowhere near is untouched', rowForDrag(newDragRowMemo(), 'C', other), other)

  // Carried back into its own row, to the seam between the two that are left.
  setClipDrag({
    fromDeck: 'A',
    clip: held,
    toDeck: 'A',
    index: 1,
    holeId: null,
    atSec: 10,
    x: 0,
    y: 0,
    width: 0,
    height: 0
  })
  const same = rowForDrag(newDragRowMemo(), 'A', row)
  ok(`its own row shows it out of the order with room where it would go — ${JSON.stringify(same.map((c) => [c.id, c.startSec]))}`,
    same.length === 2 && same[0].id === 'a' && same[1].id === 'c')
  eq('the piece before the room does not move', same[0].startSec, 0)
  eq('and the one after it is pushed along by the piece', same[1].startSec, 10 + 20)

  // Landing in a hole needs no room made for it.
  setClipDrag({
    fromDeck: 'A',
    clip: held,
    toDeck: 'B',
    index: 0,
    holeId: 'gap',
    atSec: 12,
    x: 0,
    y: 0,
    width: 0,
    height: 0
  })
  eq('a drop into empty room leaves the row as it is',
    rowForDrag(newDragRowMemo(), 'B', other), other)

  setClipDrag(null)
  eq('and with no drag every row is itself', rowForDrag(newDragRowMemo(), 'A', row), row)
}

// --- the memo hands back the same row until something changes ------------
{
  setClipDrag({
    fromDeck: 'A',
    clip: held,
    toDeck: 'B',
    index: 1,
    holeId: null,
    atSec: 5,
    x: 0,
    y: 0,
    width: 0,
    height: 0
  })
  const memo = newDragRowMemo()
  const other = [clip('x', 0, 5), clip('y', 5, 5)]
  const once = rowForDrag(memo, 'B', other)
  ok('the same array comes back while nothing changes', rowForDrag(memo, 'B', other) === once)
  setClipDrag({
    fromDeck: 'A',
    clip: held,
    toDeck: 'B',
    index: 2,
    holeId: null,
    atSec: 10,
    x: 0,
    y: 0,
    width: 0,
    height: 0
  })
  ok('and a new one once the drop moves', rowForDrag(memo, 'B', other) !== once)
  setClipDrag(null)
}
