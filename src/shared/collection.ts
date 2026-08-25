/**
 * The two-collection model.
 *
 * rekordbox is the source of truth for the library you actually curate, so
 * DJDaw mirrors it read-only and never writes back. The mirror is rebuilt from
 * the XML export on every sync, which keeps it honest: whatever rekordbox last
 * said is exactly what you see, including deletions.
 *
 * The moment you change anything on a mirrored track — a hot cue, the grid, a
 * rating — that record forks into the local collection and the edit lands
 * there. From then on the two are independent. Later rekordbox changes will not
 * reach the fork, which is the deliberate trade: the mirror stays a clean copy
 * of rekordbox and your edits are never silently overwritten by a re-export.
 */

import type { Track, TrackSource } from './types'

/** Prefix that distinguishes a mirrored record from a local one. */
export const REKORDBOX_ID_PREFIX = 'rb-'

/**
 * Ids are derived from the audio path so that the same file always resolves to
 * the same record, but the two collections live in separate namespaces so a
 * mirrored track and its fork can coexist. The prefix stays within the
 * character set the waveform cache filename validation accepts.
 */
export function localIdFor(audioKey: string): string {
  return audioKey
}

export function rekordboxIdFor(audioKey: string): string {
  return REKORDBOX_ID_PREFIX + audioKey
}

export function isRekordboxId(id: string): boolean {
  return id.startsWith(REKORDBOX_ID_PREFIX)
}

/** The audio path hash behind either kind of id. */
export function audioKeyFromId(id: string): string {
  return isRekordboxId(id) ? id.slice(REKORDBOX_ID_PREFIX.length) : id
}

export function sourceOfId(id: string): TrackSource {
  return isRekordboxId(id) ? 'rekordbox' : 'local'
}

/**
 * Copy a mirrored record into the local collection.
 *
 * `audioKey` is carried over unchanged, so the fork reuses the waveform already
 * analysed for the mirrored record.
 */
export function forkToLocal(mirrored: Track): Track {
  return {
    ...mirrored,
    id: localIdFor(mirrored.audioKey),
    source: 'local',
    forkedFrom: mirrored.id,
    // Deep-copy the parts an edit will mutate, so the fork cannot write
    // through into the mirror it came from.
    grid: mirrored.grid
      ? { ...mirrored.grid, anchors: mirrored.grid.anchors.map((a) => ({ ...a })) }
      : null,
    hotCues: mirrored.hotCues.map((c) => ({ ...c })),
    memoryCues: mirrored.memoryCues.map((c) => ({ ...c }))
  }
}

/**
 * Resolve a write to a track id.
 *
 * Returns the id the edit should be applied to, and the record to insert into
 * the local collection first when a fork is needed. Callers must use the
 * returned id afterwards: a deck holding the mirrored id has to re-point at the
 * fork, or its next edit would fork all over again.
 */
export interface WriteTarget {
  id: string
  /** Non-null when the caller must add this record to the local collection. */
  fork: Track | null
}

export function resolveWrite(
  id: string,
  local: Readonly<Record<string, Track>>,
  mirror: Readonly<Record<string, Track>>
): WriteTarget | null {
  if (!isRekordboxId(id)) return local[id] ? { id, fork: null } : null

  const mirrored = mirror[id]
  if (!mirrored) return null

  // A fork may already exist from an earlier edit. Reuse it, leaving the user's
  // work in place.
  const localId = localIdFor(mirrored.audioKey)
  if (local[localId]) return { id: localId, fork: null }

  const fork = forkToLocal(mirrored)
  return { id: fork.id, fork }
}
