/**
 * Rebuilding rekordbox's playlist folders from the flat XML list.
 *
 * The awkward cases are real ones from a big collection: playlists several
 * folders deep, folders that only exist as a path segment, two playlists with
 * the same name, and names containing the characters people actually use.
 */
import * as T from './.build/playlistTree.mjs'

const { eq, ok } = globalThis.__t

const pl = (folders, name, trackIds = []) => ({ folders, name, trackIds })

const tree = T.buildPlaylistTree([
  pl([], 'Quick Set', ['t1', 't2']),
  pl(['Gigs'], 'Summer', ['t1', 't3']),
  pl(['Gigs'], 'Winter', ['t4']),
  pl(['Gigs', '2025'], 'Warehouse', ['t5', 't6', 't7']),
  pl(['Gigs', '2025', 'Deep'], 'Closers', ['t8']),
  pl(['Crates'], 'DnB', ['t9'])
])

eq('top level has the root folders and loose playlists', tree.length, 3)
eq('folders sort before playlists', tree.map((n) => n.kind).join(','), 'folder,folder,playlist')
eq('folders are alphabetical', tree.filter((n) => n.kind === 'folder').map((n) => n.name).join(','), 'Crates,Gigs')
eq('a loose playlist stays at the top', tree[2].name, 'Quick Set')

const gigs = tree.find((n) => n.name === 'Gigs')
eq('Gigs holds a folder and two playlists', gigs.children.length, 3)
eq('its subfolder sorts first', gigs.children[0].name, '2025')
eq('then its playlists alphabetically', gigs.children.slice(1).map((n) => n.name).join(','), 'Summer,Winter')

// An intermediate folder must exist even though nothing sits directly in it.
const y2025 = gigs.children[0]
const deep = y2025.children.find((n) => n.name === 'Deep')
ok('a folder three levels down is created', deep != null)
eq('and holds its playlist', deep.children[0].name, 'Closers')

// Counts roll up through folders.
eq('a playlist counts its own tracks', deep.children[0].count, 1)
eq('a folder counts everything beneath it', y2025.count, 4)
eq('and keeps rolling up', gigs.count, 4 + 2 + 1)
eq('a sibling folder is unaffected', tree.find((n) => n.name === 'Crates').count, 1)

// Paths are unique and usable as ids.
const paths = []
T.walkPlaylistTree(tree, (n) => paths.push(n.path))
eq('every node has a distinct path', new Set(paths).size, paths.length)
ok('no path is empty', paths.every((p) => p.length > 0))

const closers = T.findPlaylistNode(tree, deep.children[0].path)
ok('a node can be found by its path', closers != null)
eq('and it is the right one', closers.name, 'Closers')
eq('an unknown path finds nothing', T.findPlaylistNode(tree, 'nope'), null)

eq('ancestors lead back to the root', T.ancestorPaths(closers.path).length, 3)
ok('and every ancestor resolves to a real folder',
  T.ancestorPaths(closers.path).every((p) => T.findPlaylistNode(tree, p)?.kind === 'folder'))

// Track order inside a playlist is rekordbox's order, not sorted.
eq('playlist track order is preserved',
  T.findPlaylistNode(tree, y2025.children.find((n) => n.name === 'Warehouse').path).trackIds.join(','),
  't5,t6,t7')

// Two playlists with the same name in one folder must both survive.
{
  const dupes = T.buildPlaylistTree([pl(['F'], 'Same', ['a']), pl(['F'], 'Same', ['b'])])
  const folder = dupes[0]
  eq('both same-named playlists are kept', folder.children.length, 2)
  ok('with different paths', folder.children[0].path !== folder.children[1].path)
  eq('both still display the same name', folder.children.map((n) => n.name).join(','), 'Same,Same')
  eq('and the folder counts both', folder.count, 2)
}

// Names with characters people actually use must not break the path scheme.
{
  const odd = T.buildPlaylistTree([
    pl(['Hip Hop / RnB'], '90s vs 00s', ['x']),
    pl(['Hip Hop / RnB'], 'B-Sides', ['y'])
  ])
  eq('a folder name containing a slash is one folder', odd.length, 1)
  eq('and keeps its name intact', odd[0].name, 'Hip Hop / RnB')
  eq('with both playlists inside', odd[0].children.length, 2)
}

eq('an empty collection yields an empty tree', T.buildPlaylistTree([]).length, 0)

// Empty folder names in the path are skipped rather than making blank folders.
{
  const blanks = T.buildPlaylistTree([pl(['', 'Real', ''], 'P', ['z'])])
  eq('only the named folder survives', blanks.length, 1)
  eq('and it is the right one', blanks[0].name, 'Real')
  eq('holding the playlist directly', blanks[0].children[0].name, 'P')
}

// A big tree should still build quickly and stay consistent.
{
  const many = []
  for (let i = 0; i < 600; i++) {
    many.push(pl(['Root' + (i % 8), 'Sub' + (i % 25)], 'List ' + i, ['id' + i]))
  }
  const big = T.buildPlaylistTree(many)
  let leaves = 0
  T.walkPlaylistTree(big, (n) => { if (n.kind === 'playlist') leaves++ })
  eq('600 playlists all land in the tree', leaves, 600)
  eq('and the root count totals them', big.reduce((a, n) => a + n.count, 0), 600)
}
