import { createRoot } from 'react-dom/client'
import { App } from '@renderer/App'

const container = document.getElementById('root')
if (!container) throw new Error('[djdaw] #root is missing from index.html')

/*
 * Deliberately not wrapped in <StrictMode>. Strict mode double-invokes effects
 * in development, and this app's effects are not idempotent in the way it
 * assumes: the deck components start requestAnimationFrame loops that draw to
 * canvases, and mounting twice leaves two loops rendering the same waveform at
 * double cost while the second AudioEngine.init() races the first. The bugs
 * strict mode is meant to surface would be hidden behind that noise, so it is
 * off and the effects are written to clean up after themselves instead.
 */
createRoot(container).render(<App />)
