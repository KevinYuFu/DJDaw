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

/**
 * Height of the clip's title strip, above the waveform.
 *
 * The strip is the clip's handle: a press there picks the clip up, and a press
 * anywhere else on the lane moves the playhead.
 */
export const CLIP_HEADER_H = 14

/** A clip about to be dropped, drawn where it will actually land. */
export interface ClipGhost {
  sourceId: string
  startSample: number
  durationSamples: number
  offsetSamples: number
  rate: number
}

export interface ArrangementClipsProps {
  lane: ClipTrack
  /** Arrangement seconds at the left edge of the strip. */
  fromSec: number
  /** Arrangement seconds per CSS pixel. */
  secPerPx: number
  height: number
  width: number
  selectedClipId: string | null
  ghost: ClipGhost | null
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
 * A clip is a window onto a source file and is drawn from that file's peaks
 * over the stretch it covers. No peaks are stored per clip.
 */
export function ArrangementClips({
  lane,
  fromSec,
  secPerPx,
  height,
  width,
  selectedClipId,
  ghost
}: ArrangementClipsProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /**
   * Peaks reduced to pixel columns, per clip. Rebuilt only when a clip's
   * window onto its file changes, or the zoom does.
   */
  const columnsRef = useRef(new Map<string, { key: string; cols: WaveformColumns }>())
  const version = useArrangement((s) => s.version)
  const masterBpm = useArrangement((s) => s.masterBpm)
  const waveforms = useArrangement((s) => s.waveforms)
  const tracks = useLibrary((s) => s.tracks)
  const colorMode = useSettings((s) => s.waveformColorMode)
  const sampleRate = useArrangement((s) => s.sampleRate)

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

    const seen = new Set<string>()
    const paint = (clip: ArrangementClip, selected: boolean, preview: boolean): void => {
      const startSec = clip.startSample / sampleRate
      const lengthSec = clip.durationSamples / sampleRate
      const x = Math.round((startSec - fromSec) / secPerPx)
      const px = Math.max(1, Math.round(lengthSec / secPerPx))
      if (x > w || x + px < 0) return

      const track = tracks[clip.sourceId]
      const wave = waveforms[clip.sourceId]
      if (preview) ctx.globalAlpha = 0.5

      ctx.save()
      ctx.beginPath()
      ctx.rect(x, 0, px, h)
      ctx.clip()

      ctx.fillStyle = selected ? 'rgba(90, 122, 168, 0.30)' : 'rgba(58, 74, 100, 0.22)'
      ctx.fillRect(x, 0, px, h)
      ctx.fillStyle = selected ? 'rgba(120, 156, 210, 0.55)' : 'rgba(90, 110, 145, 0.40)'
      ctx.fillRect(x, 0, px, CLIP_HEADER_H)

      if (wave) {
        const [srcFrom, srcTo] = sourceRange(clip, sampleRate)
        const visibleFrom = Math.max(0, -x)
        const visibleTo = Math.min(px, w - x)
        const from = srcFrom + (visibleFrom / px) * (srcTo - srcFrom)
        const to = srcFrom + (visibleTo / px) * (srcTo - srcFrom)
        const count = Math.max(1, visibleTo - visibleFrom)
        const key = `${clip.sourceId}|${from.toFixed(4)}|${to.toFixed(4)}|${count}`
        let held = columnsRef.current.get(clip.id)
        if (!held || held.key !== key) {
          held = { key, cols: buildColumns(wave, from, to, count, wave.sampleRate, held?.cols) }
          columnsRef.current.set(clip.id, held)
        }
        seen.add(clip.id)
        const cols = held.cols
        drawWaveform(ctx, cols, {
          height: h - CLIP_HEADER_H,
          y: CLIP_HEADER_H,
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
          ctx.fillRect(cx, CLIP_HEADER_H, 1.5, h - CLIP_HEADER_H)
          ctx.fillRect(cx, CLIP_HEADER_H, 5, 4)
        }
      }

      ctx.fillStyle = 'rgba(255, 255, 255, 0.86)'
      ctx.font = '10px -apple-system, system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.fillText(clip.name ?? track?.title ?? 'Clip', x + 5, CLIP_HEADER_H / 2 + 0.5)

      if (preview) {
        // Dashed: a place, not a clip that is there.
        ctx.strokeStyle = 'rgba(190, 215, 255, 0.95)'
        ctx.lineWidth = 2
        ctx.setLineDash([5, 3])
      } else {
        ctx.strokeStyle = selected ? 'rgba(160, 195, 255, 0.95)' : 'rgba(150, 170, 200, 0.45)'
        ctx.lineWidth = selected ? 2 : 1
      }
      ctx.strokeRect(x + 0.5, 0.5, px - 1, h - 1)
      ctx.restore()
      ctx.globalAlpha = 1
    }

    for (const raw of lane.clips) {
      const clip = raw as ArrangementClip
      paint(clip, clip.id === selectedClipId, false)
    }
    if (ghost) {
      paint(
        {
          ...(ghost as unknown as ArrangementClip),
          id: 'ghost',
          sampleRate,
          sourceDurationSamples: ghost.durationSamples + ghost.offsetSamples,
          gain: 1,
          name: tracks[ghost.sourceId]?.title
        },
        false,
        true
      )
    }
    // Drop the columns of clips that are gone or off screen.
    for (const id of columnsRef.current.keys()) {
      if (!seen.has(id)) columnsRef.current.delete(id)
    }
  }, [
    lane,
    fromSec,
    secPerPx,
    width,
    height,
    selectedClipId,
    ghost,
    sampleRate,
    version,
    masterBpm,
    waveforms,
    tracks,
    colorMode
  ])

  return <canvas className="arr-lane__canvas" ref={canvasRef} />
}
