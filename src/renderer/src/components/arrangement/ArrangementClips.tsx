import { useEffect, useRef, type ReactElement } from 'react'
import type { ClipTrack } from '@waveform-playlist/core'
import type { HotCue } from '@shared/types'
import { useLibrary } from '@renderer/state/useLibrary'
import { useSettings } from '@renderer/state/useSettings'
import { useArrangement } from '@renderer/state/useArrangement'
import type { ArrangementClip } from '@renderer/arrangement/WorkletPlayout'
import { BAND_COLORS } from '@renderer/core/constants'
import {
  buildColumns,
  drawWaveform,
  type WaveformColumns
} from '@renderer/components/waveform/waveformRender'

/** Height of the clip's title strip, above the waveform. */
const HEADER_H = 14

export interface ArrangementClipsProps {
  lane: ClipTrack
  /** Arrangement seconds at the left edge of the strip. */
  fromSec: number
  /** Arrangement seconds per CSS pixel. */
  secPerPx: number
  height: number
  width: number
  selectedClipId: string | null
}

/** Where a clip reads from its source file, in file seconds. */
function sourceRange(clip: ArrangementClip, sampleRate: number): [number, number] {
  const from = (clip.offsetSamples * clip.rate) / sampleRate
  const to = ((clip.offsetSamples + clip.durationSamples) * clip.rate) / sampleRate
  return [from, to]
}

/** The cues of a clip's source that fall inside it, as arrangement seconds. */
function cuesInClip(
  clip: ArrangementClip,
  cues: readonly HotCue[],
  sampleRate: number
): { at: number; color: string }[] {
  const [from, to] = sourceRange(clip, sampleRate)
  const startSec = clip.startSample / sampleRate
  const out: { at: number; color: string }[] = []
  for (const cue of cues) {
    if (cue.time < from || cue.time > to) continue
    out.push({ at: startSec + (cue.time - from) / clip.rate, color: cue.color })
  }
  return out
}

/**
 * The clips of one lane, drawn on a canvas.
 *
 * A clip is a window onto a source file, so it is drawn straight from that
 * file's peaks over the stretch it covers — no peaks are stored per clip, and
 * cutting one in two costs nothing but two narrower windows onto the same
 * summary.
 */
export function ArrangementClips({
  lane,
  fromSec,
  secPerPx,
  height,
  width,
  selectedClipId
}: ArrangementClipsProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const columnsRef = useRef<WaveformColumns | null>(null)
  const version = useArrangement((s) => s.version)
  const masterBpm = useArrangement((s) => s.masterBpm)
  const waveforms = useArrangement((s) => s.waveforms)
  const tracks = useLibrary((s) => s.tracks)
  const colorMode = useSettings((s) => s.waveformColorMode)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const sampleRate = 48000
    for (const raw of lane.clips) {
      const clip = raw as ArrangementClip
      const startSec = clip.startSample / sampleRate
      const lengthSec = clip.durationSamples / sampleRate
      const x = Math.round((startSec - fromSec) / secPerPx)
      const px = Math.max(1, Math.round(lengthSec / secPerPx))
      if (x > w || x + px < 0) continue

      const selected = clip.id === selectedClipId
      const track = tracks[clip.sourceId]
      const wave = waveforms[clip.sourceId]

      ctx.save()
      ctx.beginPath()
      ctx.rect(x, 0, px, h)
      ctx.clip()

      ctx.fillStyle = selected ? 'rgba(90, 122, 168, 0.30)' : 'rgba(58, 74, 100, 0.22)'
      ctx.fillRect(x, 0, px, h)
      ctx.fillStyle = selected ? 'rgba(120, 156, 210, 0.55)' : 'rgba(90, 110, 145, 0.40)'
      ctx.fillRect(x, 0, px, HEADER_H)

      if (wave) {
        const [srcFrom, srcTo] = sourceRange(clip, sampleRate)
        const visibleFrom = Math.max(0, -x)
        const visibleTo = Math.min(px, w - x)
        const cols = buildColumns(
          wave,
          srcFrom + (visibleFrom / px) * (srcTo - srcFrom),
          srcFrom + (visibleTo / px) * (srcTo - srcFrom),
          Math.max(1, visibleTo - visibleFrom),
          wave.sampleRate,
          columnsRef.current
        )
        columnsRef.current = cols
        drawWaveform(ctx, cols, {
          height: h - HEADER_H,
          y: HEADER_H,
          x: x + visibleFrom,
          colors: BAND_COLORS,
          rgb: colorMode === 'rgb',
          mono: colorMode === 'mono' ? '#cfd8e6' : undefined,
          dim: selected ? 1 : 0.86
        })
      }

      if (track) {
        for (const cue of cuesInClip(clip, track.hotCues ?? [], sampleRate)) {
          const cx = Math.round((cue.at - fromSec) / secPerPx)
          ctx.fillStyle = cue.color
          ctx.fillRect(cx, HEADER_H, 1.5, h - HEADER_H)
          ctx.fillRect(cx, HEADER_H, 5, 4)
        }
      }

      ctx.fillStyle = 'rgba(255, 255, 255, 0.86)'
      ctx.font = '10px -apple-system, system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.fillText(clip.name ?? track?.title ?? 'Clip', x + 5, HEADER_H / 2 + 0.5)

      ctx.strokeStyle = selected ? 'rgba(160, 195, 255, 0.95)' : 'rgba(150, 170, 200, 0.45)'
      ctx.lineWidth = selected ? 2 : 1
      ctx.strokeRect(x + 0.5, 0.5, px - 1, h - 1)
      ctx.restore()
    }
  }, [
    lane,
    fromSec,
    secPerPx,
    width,
    height,
    selectedClipId,
    version,
    masterBpm,
    waveforms,
    tracks,
    colorMode
  ])

  return <canvas className="arr-lane__canvas" ref={canvasRef} />
}
