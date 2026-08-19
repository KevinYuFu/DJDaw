/** Display helpers. Kept dependency-free so workers can use them too. */

/** `m:ss` with centiseconds, the way a CDJ shows elapsed time: `3:41.2`. */
export function formatTime(sec: number, withTenths = true): string {
  if (!isFinite(sec)) return withTenths ? '0:00.0' : '0:00'
  const neg = sec < 0
  const s = Math.abs(sec)
  const m = Math.floor(s / 60)
  const rem = s - m * 60
  const ss = Math.floor(rem)
  const body = `${m}:${String(ss).padStart(2, '0')}`
  const out = withTenths ? `${body}.${Math.floor((rem - ss) * 10)}` : body
  return neg ? `-${out}` : out
}

/** `mm:ss` for the browser's time column. */
export function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '--:--'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec - m * 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Tempo with the two decimals rekordbox shows. */
export function formatBpm(bpm: number | null): string {
  return bpm == null || !isFinite(bpm) ? '--.--' : bpm.toFixed(2)
}

/** Tempo fader readout: always signed, two decimals. */
export function formatPitch(percent: number): string {
  const sign = percent > 0 ? '+' : percent < 0 ? '-' : ' '
  return `${sign}${Math.abs(percent).toFixed(2)}%`
}

/** `bar.beat` counter, 1-based, the way rekordbox's beat counter reads. */
export function formatBarBeat(bar: number, beatInBar: number): string {
  return `${bar + 1}.${beatInBar + 1}`
}

/** Beat-jump / loop size label: `1/4`, `1`, `16`. */
export function formatBeats(beats: number): string {
  if (beats >= 1) return String(beats)
  const denom = Math.round(1 / beats)
  return `1/${denom}`
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
