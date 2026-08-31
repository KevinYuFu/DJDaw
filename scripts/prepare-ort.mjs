/**
 * Put ONNX Runtime's WebAssembly files where the renderer can load them.
 *
 * The runtime fetches these at run time by name, so they have to be served
 * rather than bundled. Copied out of the package into the renderer's public
 * folder, which the build carries through untouched.
 */
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FROM = join(HERE, '..', 'node_modules', 'onnxruntime-web', 'dist')
const INTO = join(HERE, '..', 'src', 'renderer', 'public', 'ort')

/**
 * The build the runtime actually reaches for on the WebGPU backend, which is
 * the one the app asks for. It resolves these by name at run time, so they
 * have to be served rather than bundled. The package carries three other
 * builds worth 55 MB between them that are never fetched.
 */
const WANTED = /^ort-wasm-simd-threaded\.asyncify\.(wasm|mjs)$/

const files = (await readdir(FROM)).filter((f) => WANTED.test(f))
if (files.length === 0) {
  console.error(`no ONNX Runtime wasm found in ${FROM}`)
  process.exit(1)
}
await mkdir(INTO, { recursive: true })
for (const file of files) await copyFile(join(FROM, file), join(INTO, file))
console.log(`ONNX Runtime wasm ready (${files.join(', ')})`)
