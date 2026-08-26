import type { ReactElement } from 'react'

export interface LaneHeaderProps {
  /** The lane's letter. */
  name: string
  muted: boolean
  soloed: boolean
  onToggleMute(): void
  onToggleSolo(): void
}

/** The block at the head of a lane: which lane it is, and its two toggles. */
export function LaneHeader({
  name,
  muted,
  soloed,
  onToggleMute,
  onToggleSolo
}: LaneHeaderProps): ReactElement {
  return (
    <div
      className={`arr-head${muted ? ' is-muted' : ''}${soloed ? ' is-soloed' : ''}`}
    >
      <span className="arr-head__letter">{name}</span>
      <div className="arr-head__switch">
        <button
          type="button"
          className="arr-head__toggle arr-head__toggle--mute"
          title={`Mute lane ${name}`}
          aria-pressed={muted}
          onClick={onToggleMute}
        >
          Mute
        </button>
        <button
          type="button"
          className="arr-head__toggle arr-head__toggle--solo"
          title={`Solo lane ${name}`}
          aria-pressed={soloed}
          onClick={onToggleSolo}
        >
          Solo
        </button>
      </div>
    </div>
  )
}
