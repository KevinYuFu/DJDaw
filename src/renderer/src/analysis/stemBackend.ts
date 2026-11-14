/**
 * Which ONNX Runtime backend a stem split runs on, and falling back when one fails.
 *
 * WebGPU is tried first where it is offered. If it fails to start or fails part
 * way through, the split runs again on WASM, and WebGPU is skipped from then on.
 */

/** Where the runtime ran, which is the difference between seconds and minutes. */
export type StemBackend = 'webgpu' | 'wasm'

/** What has failed so far, kept for as long as the worker lives. */
export interface BackendMemory {
  webgpuFailed: boolean
}

export function freshBackendMemory(): BackendMemory {
  return { webgpuFailed: false }
}

/** The backends to try, in order. */
export function backendOrder(gpuOffered: boolean, memory: BackendMemory): StemBackend[] {
  return gpuOffered && !memory.webgpuFailed ? ['webgpu', 'wasm'] : ['wasm']
}

/**
 * Run `attempt` on each backend in turn until one succeeds.
 *
 * A WebGPU failure is recorded in `memory` and the next backend is tried. The
 * last backend's error is the one thrown if every backend fails.
 */
export async function runWithFallback<T>(
  order: StemBackend[],
  memory: BackendMemory,
  attempt: (backend: StemBackend) => Promise<T>,
  onFallback?: (failed: StemBackend, err: unknown) => void
): Promise<{ result: T; backend: StemBackend }> {
  if (order.length === 0) throw new Error('no backend to split on')
  let lastError: unknown
  for (let i = 0; i < order.length; i++) {
    const backend = order[i]
    try {
      return { result: await attempt(backend), backend }
    } catch (err) {
      lastError = err
      if (backend === 'webgpu') memory.webgpuFailed = true
      if (i < order.length - 1) onFallback?.(backend, err)
    }
  }
  throw lastError
}
