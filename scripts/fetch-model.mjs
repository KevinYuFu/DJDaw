/**
 * Fetch the stem separation model.
 *
 * The model is 302 MB, which does not belong in the repository, so it is
 * pulled once and left in `resources/` where the build picks it up. Already
 * there and the right size, nothing happens.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const INTO = join(HERE, '..', 'resources', 'htdemucs.onnx')
const FROM = 'https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/main/htdemucs.onnx'
/** Anything much smaller than this is a truncated download, not the model. */
const LEAST_BYTES = 250_000_000

const have = await stat(INTO).catch(() => null)
if (have && have.size >= LEAST_BYTES) {
  console.log(`stem model already here (${(have.size / 1e6).toFixed(0)} MB)`)
  process.exit(0)
}

console.log('fetching the stem model, 302 MB, once')
const res = await fetch(FROM)
if (!res.ok || !res.body) {
  console.error(`could not fetch the model: ${res.status} ${res.statusText}`)
  process.exit(1)
}
await mkdir(dirname(INTO), { recursive: true })
const pending = `${INTO}.part`
await pipeline(Readable.fromWeb(res.body), createWriteStream(pending))
const got = await stat(pending)
if (got.size < LEAST_BYTES) {
  await rm(pending, { force: true })
  console.error(`the download stopped short at ${(got.size / 1e6).toFixed(0)} MB`)
  process.exit(1)
}
await rename(pending, INTO)
console.log(`stem model ready (${(got.size / 1e6).toFixed(0)} MB)`)
