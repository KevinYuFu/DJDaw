/**
 * Falling back from WebGPU to WASM when a stem split fails.
 */
import { backendOrder, freshBackendMemory, runWithFallback } from './.build/stemBackend.mjs'

const { eq, ok } = globalThis.__t

// Which backends get tried
eq('WebGPU first, then WASM, when a GPU is offered', backendOrder(true, freshBackendMemory()).join(','), 'webgpu,wasm')
eq('only WASM when no GPU is offered', backendOrder(false, freshBackendMemory()).join(','), 'wasm')
eq('only WASM once WebGPU has failed', backendOrder(true, { webgpuFailed: true }).join(','), 'wasm')

// WebGPU works
{
  const memory = freshBackendMemory()
  const tried = []
  const { result, backend } = await runWithFallback(['webgpu', 'wasm'], memory, async (b) => {
    tried.push(b)
    return 'stems'
  })
  eq('a working GPU runs the split', backend, 'webgpu')
  eq('and hands back its result', result, 'stems')
  eq('without touching WASM', tried.join(','), 'webgpu')
  eq('and nothing is marked failed', memory.webgpuFailed, false)
}

// WebGPU fails to start, or fails part way through
{
  const memory = freshBackendMemory()
  const tried = []
  const fellBack = []
  const { result, backend } = await runWithFallback(
    ['webgpu', 'wasm'],
    memory,
    async (b) => {
      tried.push(b)
      if (b === 'webgpu') throw new Error('no adapter')
      return 'cpu stems'
    },
    (failed, err) => fellBack.push(`${failed}:${err.message}`)
  )
  eq('a failed GPU falls back to WASM', backend, 'wasm')
  eq('which hands back its result', result, 'cpu stems')
  eq('both were tried, GPU first', tried.join(','), 'webgpu,wasm')
  eq('the fallback is reported once', fellBack.join('|'), 'webgpu:no adapter')
  eq('and WebGPU is remembered as failed', memory.webgpuFailed, true)
  eq('so the next split goes straight to WASM', backendOrder(true, memory).join(','), 'wasm')
}

// Both fail
{
  const memory = freshBackendMemory()
  let fallbacks = 0
  let caught = null
  try {
    await runWithFallback(
      ['webgpu', 'wasm'],
      memory,
      async (b) => {
        throw new Error(`${b} broke`)
      },
      () => fallbacks++
    )
  } catch (err) {
    caught = err
  }
  ok('the split fails when every backend fails', caught instanceof Error)
  eq('with the last backend\'s error', caught?.message, 'wasm broke')
  eq('having fallen back only once', fallbacks, 1)
}

// WASM alone fails
{
  const memory = freshBackendMemory()
  let caught = null
  try {
    await runWithFallback(['wasm'], memory, async () => {
      throw new Error('out of memory')
    })
  } catch (err) {
    caught = err
  }
  eq('a WASM failure is passed straight on', caught?.message, 'out of memory')
  eq('and does not mark WebGPU failed', memory.webgpuFailed, false)
}

// Nothing to try
{
  let caught = null
  try {
    await runWithFallback([], freshBackendMemory(), async () => 'never')
  } catch (err) {
    caught = err
  }
  ok('an empty list is an error, not a silent success', caught instanceof Error)
}
