/**
 * Where a dropped track lands.
 *
 * The preview under the cursor and the clip that is actually made both come
 * from here, so these are the numbers the picture promises.
 */
import { placeClip } from './.build/placement.mjs'

const { eq, ok } = globalThis.__t

const SR = 48000
const base = { sourceFrames: SR * 200, downbeatSec: 0, trackBpm: 120, masterBpm: 120, sampleRate: SR }

// A track at the grid tempo, dropped well past its intro.
{
  const p = placeClip({ ...base, atSeconds: 10 })
  eq('a track at the grid tempo is not warped', p.rate, 1)
  eq('it starts where it was dropped', p.startSample, 10 * SR)
  eq('nothing is trimmed off the front', p.offsetSamples, 0)
  eq('and the whole file is there', p.durationSamples, 200 * SR)
}

// The first downbeat is what lands on the drop point, not the file start.
{
  const p = placeClip({ ...base, downbeatSec: 4, atSeconds: 10 })
  eq('the clip starts an intro ahead of the drop', p.startSample, 6 * SR)
  eq('so the downbeat is exactly on the drop point', p.startSample + 4 * SR, 10 * SR)
  eq('and none of the intro is lost', p.offsetSamples, 0)
}

// Dropped too close to zero for the intro to fit, it is trimmed.
{
  const p = placeClip({ ...base, downbeatSec: 4, atSeconds: 1 })
  eq('the clip cannot start before zero', p.startSample, 0)
  eq('so the part that would have is trimmed', p.offsetSamples, 3 * SR)
  eq('the downbeat still lands on the drop point', p.startSample + (4 - 3) * SR, 1 * SR)
  eq('and the clip is shorter by what was trimmed', p.durationSamples, (200 - 3) * SR)
}

// Warping changes the length on the grid, and the intro with it.
{
  const p = placeClip({ ...base, trackBpm: 150, masterBpm: 120, atSeconds: 20 })
  eq('a 150 track on a 120 grid reads at 0.8', p.rate, 0.8)
  eq('so it occupies more of the grid', p.durationSamples, (200 / 0.8) * SR)
  eq('and its whole length is that too', p.sourceDurationSamples, (200 / 0.8) * SR)
}
{
  const p = placeClip({ ...base, trackBpm: 150, masterBpm: 120, downbeatSec: 4, atSeconds: 20 })
  // The intro is 4 file seconds, which is 5 grid seconds at 0.8.
  eq('a warped intro is measured on the grid, not in the file', p.startSample, 15 * SR)
  ok('and the downbeat is still on the drop point', Math.abs(p.startSample + (4 / 0.8) * SR - 20 * SR) < 2)
}

// An unanalysed track has nothing to warp to and is laid down as it is.
{
  const p = placeClip({ ...base, trackBpm: 0, atSeconds: 10 })
  eq('a track with no tempo is not warped', p.rate, 1)
  eq('and lands where it was dropped', p.startSample, 10 * SR)
}

// A clip is never zero-length, whatever it is asked for.
{
  const p = placeClip({ ...base, sourceFrames: 0, atSeconds: 0 })
  ok('a clip always has some length', p.durationSamples >= 1)
}
