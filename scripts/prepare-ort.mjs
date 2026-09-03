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
const PUBLIC = join(HERE, '..', 'src', 'renderer', 'public')

/**
 * Two runtimes, kept apart on purpose.
 *
 * Stem separation drives ONNX Runtime directly; transcription goes through
 * transformers.js, which carries its own copy at a different version. Pointing
 * both at one folder means whichever loads second gets the wrong build, so
 * each is served the files it shipped with.
 */
const SOURCES = [
  {
    from: join(HERE, '..', 'node_modules', 'onnxruntime-web', 'dist'),
    into: join(PUBLIC, 'ort'),
    // What the WebGPU backend reaches for. The package carries three other
    // builds worth 55 MB between them that are never fetched.
    wanted: /^ort-wasm-simd-threaded\.asyncify\.(wasm|mjs)$/,
    label: 'stem separation'
  },
  {
    from: join(HERE, '..', 'node_modules', '@huggingface', 'transformers', 'dist'),
    into: join(PUBLIC, 'ort-transformers'),
    wanted: /^ort-wasm-simd-threaded\.jsep\.(wasm|mjs)$/,
    label: 'transcription'
  }
]

for (const { from, into, wanted, label } of SOURCES) {
  const files = (await readdir(from)).filter((f) => wanted.test(f))
  if (files.length === 0) {
    console.error(`no ONNX Runtime wasm for ${label} in ${from}`)
    process.exit(1)
  }
  await mkdir(into, { recursive: true })
  for (const file of files) await copyFile(join(from, file), join(into, file))
  console.log(`${label}: ${files.length} runtime files ready`)
}
