/**
 * Run the esbuild binary Vite already ships.
 *
 * `node_modules/.bin/esbuild` is a shell script on Windows, which execFileSync
 * cannot run; there the package's own launcher is run through Node instead.
 * Everywhere else it is called exactly as before.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function esbuild(args) {
  const [bin, ...pre] =
    process.platform === 'win32'
      ? [process.execPath, join(root, 'node_modules/esbuild/bin/esbuild')]
      : [join(root, 'node_modules/.bin/esbuild')]
  execFileSync(bin, [...pre, ...args], { stdio: ['ignore', 'ignore', 'inherit'] })
}