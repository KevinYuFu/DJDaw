/**
 * Fetch the transcription model a censor listens with.
 *
 * Pulled once into the renderer's public folder, where the build carries it
 * through and the app reads it off disk. Kept out of the repository: it is a
 * few hundred megabytes of weights, and weights do not belong in git.
 *
 * Only the files the runtime asks for. The published model carries a dozen
 * quantisations of each graph and we use one.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * Whisper base, from the export that states its terms.
 *
 * Several exports of these weights are published; most say nothing about their
 * licence. This one says Apache-2.0, matching the weights OpenAI released, so
 * the chain from their release to this app is written down at every step.
 */
const NAME = 'whisper-base'
const OWNER = 'Xenova'
const INTO = join(HERE, '..', 'src', 'renderer', 'public', 'models', NAME)
const FROM = `https://huggingface.co/${OWNER}/${NAME}/resolve/main`

const FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'added_tokens.json',
  'merges.txt',
  'normalizer.json',
  'vocab.json',
  'special_tokens_map.json',
  'onnx/encoder_model.onnx',
  'onnx/decoder_model_merged.onnx'
]

/** Files the model works without. Missing ones are not worth failing over. */
const OPTIONAL = new Set(['special_tokens_map.json', 'added_tokens.json', 'normalizer.json'])

let fetched = 0
let already = 0
for (const file of FILES) {
  const to = join(INTO, file)
  const have = await stat(to).catch(() => null)
  if (have && have.size > 0) {
    already += 1
    continue
  }
  const res = await fetch(`${FROM}/${file}`)
  if (!res.ok || !res.body) {
    if (OPTIONAL.has(file)) continue
    console.error(`could not fetch ${file}: ${res.status} ${res.statusText}`)
    process.exit(1)
  }
  await mkdir(dirname(to), { recursive: true })
  const pending = `${to}.part`
  await pipeline(Readable.fromWeb(res.body), createWriteStream(pending))
  if ((await stat(pending)).size === 0) {
    await rm(pending, { force: true })
    console.error(`${file} came back empty`)
    process.exit(1)
  }
  await rename(pending, to)
  fetched += 1
  console.log(`  ${file}`)
}
console.log(`transcription model ready (${fetched} fetched, ${already} already here)`)
