/**
 * Stem separation.
 *
 * A track is split into four parts that add back up to it: drums, bass, other,
 * and vocals. Each part is written as its own audio file, so the rest of the
 * app can treat a stem as an ordinary source.
 */

/** The parts a track is split into, in the order the model returns them. */
export const STEM_NAMES = ['drums', 'bass', 'other', 'vocals'] as const

export type StemName = (typeof STEM_NAMES)[number]

/** Sample rate the model works at. Audio is resampled to this to be split. */
export const STEM_SAMPLE_RATE = 44100

/** Frames the model reads at a time. 7.8 seconds at {@link STEM_SAMPLE_RATE}. */
export const STEM_SEGMENT_FRAMES = 343980

/** How far one segment reaches back over the last, to be faded across. */
export const STEM_OVERLAP_FRAMES = Math.floor(STEM_SEGMENT_FRAMES / 4)

/** How far a split has got. */
export interface StemProgress {
  /** The track being split. */
  trackId: string
  /** 0-1. */
  ratio: number
}

/** Where a track's four stems ended up. */
export interface StemFiles {
  trackId: string
  /** Absolute path per stem, in {@link STEM_NAMES} order. */
  paths: Record<StemName, string>
}

/**
 * The fade applied across a segment's overlap, so segments join without a seam.
 *
 * Linear in and out. Each frame is divided by the total weight laid over it,
 * which is what makes the join seamless whatever the shape of the fade.
 *
 * The fade never reaches zero. The first segment has nothing overlapping its
 * start and the last has nothing overlapping its end, so a frame weighted zero
 * there would be divided by nothing and come out silent.
 */
export function segmentWindow(frames: number, overlap: number): Float32Array {
  const w = new Float32Array(frames).fill(1)
  if (overlap <= 1) return w
  for (let i = 0; i < overlap; i++) {
    const f = (i + 1) / (overlap + 1)
    w[i] = f
    w[frames - 1 - i] = f
  }
  return w
}

/** Where each segment starts, for audio of `frames` length. */
export function segmentStarts(frames: number, segment: number, overlap: number): number[] {
  const stride = Math.max(1, segment - overlap)
  const count = Math.max(1, Math.ceil(frames / stride))
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const start = i * stride
    if (i > 0 && start >= frames) break
    out.push(start)
  }
  return out
}
