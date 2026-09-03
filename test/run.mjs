/**
 * Minimal test runner. Transpiles the TypeScript under test with the esbuild
 * binary Vite already ships, then imports and runs every *.test.mjs in this
 * directory. Deliberately dependency-free: a DJ app does not need a test
 * framework to check that a beat jump lands on the beat.
 *
 *   node test/run.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(here, '.build')

/** TypeScript modules the tests import, transpiled to plain ESM. */
const MODULES = [
  'src/renderer/src/core/beatgrid.ts',
  'src/renderer/src/core/format.ts',
  'src/renderer/src/analysis/bpm.worker.ts',
  'src/shared/rekordboxXml.ts',
  'src/shared/rekordboxImport.ts',
  'src/shared/collection.ts',
  'src/shared/playlistTree.ts',
  'src/shared/clips.ts',
  'src/shared/eq.ts',
  'src/shared/pointsOfInterest.ts',
  'src/shared/wav.ts',
  'src/shared/deckList.ts',
  'src/shared/fader.ts',
  'src/shared/ffmpegArgs.ts',
  'src/shared/stems.ts',
  'src/shared/censor.ts',
  'src/shared/badWords.ts',
  'src/renderer/src/audio/decode.ts',
  'src/renderer/src/components/waveform/waveformRender.ts',
  'src/renderer/src/components/waveform/clipSlide.ts',
  'src/renderer/src/analysis/playbackRate.ts',
  'src/renderer/src/arrangement/placement.ts',
  'src/renderer/src/arrangement/laneEdit.ts',
  'src/renderer/src/arrangement/zoom.ts',
  'src/renderer/src/arrangement/laneTitle.ts',
  'src/renderer/src/arrangement/beatJump.ts',
  'src/renderer/src/arrangement/session.ts',
  'src/renderer/src/styles/themes.ts',
  'src/renderer/src/state/viewNames.ts'
]

/** The renderer's path aliases, which Vite supplies in the app. */
const ALIASES = [
  `--alias:@renderer=${join(root, 'src/renderer/src')}`,
  `--alias:@shared=${join(root, 'src/shared')}`
]

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const esbuild = join(root, 'node_modules/.bin/esbuild')
for (const mod of MODULES) {
  const name = mod.split('/').pop().replace(/\.ts$/, '.mjs')
  // Bundled, not just transpiled: these modules import each other at runtime
  // and Node's ESM resolver needs real extensions on the specifiers.
  execFileSync(
    esbuild,
    [join(root, mod), '--bundle', '--format=esm', ...ALIASES, `--outfile=${join(outDir, name)}`],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  )
}

let pass = 0
let fail = 0
const failures = []

globalThis.__t = {
  eq(name, actual, expected, tol = 1e-9) {
    // Object.is first: it is the only thing that gets -Infinity, NaN and -0
    // right. Subtracting two infinities gives NaN, which would fail a
    // tolerance check on values that are in fact identical.
    const numeric =
      typeof actual === 'number' &&
      typeof expected === 'number' &&
      Number.isFinite(actual) &&
      Number.isFinite(expected)
    if (Object.is(actual, expected) || (numeric && Math.abs(actual - expected) <= tol)) {
      pass++
    } else {
      fail++
      failures.push(`${name}\n    got      ${actual}\n    expected ${expected}`)
    }
  },
  ok(name, cond) {
    cond ? pass++ : (fail++, failures.push(name))
  }
}

for (const file of readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort()) {
  await import(pathToFileURL(join(here, file)).href)
}

if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  ${f}`)
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
