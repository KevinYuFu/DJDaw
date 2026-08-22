import { DECK_IDS, type DeckId } from '@shared/types'
import { clamp } from '@renderer/core/format'
import { DECK_WORKLET_URL } from '@renderer/audio/deckProtocol'
import { Deck } from '@renderer/audio/Deck'

/**
 * The audio graph: one AudioContext, one deck per {@link DECK_IDS}, one master
 * gain.
 *
 *   Deck A ─┐
 *   ...     ├─> master ─> destination
 *   Deck D ─┘
 *
 * Each deck is its own channel strip — worklet, trim, three EQ bands, the
 * filter knob, then its output gain — so a deck arrives here already mixed and
 * the master node only sets the overall level. See `Deck`.
 *
 * A singleton because there is exactly one output device and the worklet
 * module is registered per context; every module that needs audio reaches it
 * through `AudioEngine.shared()`.
 *
 * Every deck exists from the moment the engine starts, whatever the view is
 * showing: a deck costs nothing until audio is loaded into it, and switching
 * views must not have to build or tear down audio nodes.
 */

/** Time constant of the master volume ramp. Short enough to feel instant. */
const MASTER_RAMP_SEC = 0.015

/** +12 dB ceiling, so a bad value from the UI cannot blow up the output. */
const MAX_GAIN = 4

export class AudioEngine {
  private static instance: AudioEngine | null = null

  private graph: { ctx: AudioContext; master: GainNode } | null = null
  private decks: Record<DeckId, Deck> | null = null
  private ready: Promise<void> | null = null
  private extra = new Map<string, Deck>()

  private constructor() {}

  static shared(): AudioEngine {
    if (!AudioEngine.instance) AudioEngine.instance = new AudioEngine()
    return AudioEngine.instance
  }

  get ctx(): AudioContext {
    return this.ensureGraph().ctx
  }

  get master(): GainNode {
    return this.ensureGraph().master
  }

  /**
   * Create the context and load the deck worklet, then build every deck.
   * Idempotent: concurrent callers await the same promise, and a resolved
   * engine is not rebuilt. A failure is not cached, so a retry can work.
   */
  init(): Promise<void> {
    if (!this.ready) {
      this.ready = this.start().catch((err: unknown) => {
        this.ready = null
        throw err
      })
    }
    return this.ready
  }

  /**
   * Resume the context after a user gesture. Nothing plays until this has
   * run at least once, so it belongs on the app's first click or keypress.
   */
  async resume(): Promise<void> {
    const { ctx } = this.ensureGraph()
    if (ctx.state === 'suspended') await ctx.resume()
  }

  /**
   * A deck outside the four, made on first ask and kept by name.
   *
   * The arrangement view plays one of these per track and file. They are not
   * in {@link DECK_IDS} and nothing that walks the decks can see them.
   */
  namedDeck(key: string): Deck {
    const held = this.extra.get(key)
    if (held) return held
    if (!this.decks) {
      throw new Error(`AudioEngine.namedDeck('${key}') called before init() resolved`)
    }
    const made = new Deck(key, this.ctx, this.master)
    this.extra.set(key, made)
    return made
  }

  /** Take a named deck out of the graph and forget it. */
  dropNamedDeck(key: string): void {
    const held = this.extra.get(key)
    if (!held) return
    this.extra.delete(key)
    held.dispose()
  }

  deck(id: DeckId): Deck {
    if (!this.decks) {
      throw new Error(`AudioEngine.deck('${id}') called before init() resolved`)
    }
    return this.decks[id]
  }

  setMasterVolume(linear: number): void {
    if (!Number.isFinite(linear)) return
    const { ctx, master } = this.ensureGraph()
    // Ramped, not stepped: a jump in gain is an audible click on a live rig.
    master.gain.setTargetAtTime(clamp(linear, 0, MAX_GAIN), ctx.currentTime, MASTER_RAMP_SEC)
  }

  private async start(): Promise<void> {
    const { ctx, master } = this.ensureGraph()
    await ctx.audioWorklet.addModule(new URL(DECK_WORKLET_URL, window.location.href).href)
    const decks = {} as Record<DeckId, Deck>
    for (const id of DECK_IDS) decks[id] = new Deck(id, ctx, master)
    this.decks = decks
  }

  /**
   * The context is built on first touch rather than only in `init()`, because
   * decoding and offline analysis legitimately need it before the worklet
   * module has finished loading. It starts suspended either way, until
   * {@link resume} is called from a user gesture.
   */
  private ensureGraph(): { ctx: AudioContext; master: GainNode } {
    if (!this.graph) {
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      const master = ctx.createGain()
      master.gain.value = 1
      master.connect(ctx.destination)
      this.graph = { ctx, master }
    }
    return this.graph
  }
}
