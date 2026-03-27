'use client'

import { useRef, useEffect, useCallback } from 'react'

// ─── Constants ────────────────────────────────────────────────────────────────
const PX_PER_SEC   = 44      // pixels per second of audio
const INDICATOR_X  = 88      // fixed X of the red playhead from left
const RULER_H      = 64      // total canvas height in CSS px
const LABEL_BASELINE_Y = 39  // y of ruler time text baseline
const LABEL_BOTTOM_Y   = 42  // approx lower edge of ruler time text
const TICK_MAJOR_H     = LABEL_BOTTOM_Y
const TICK_MINOR_H     = LABEL_BOTTOM_Y - 14
const LABEL_OFFSET = 4       // gap between tick right edge and label
const DEAD_ZONE    = 12      // px dead zone before velocity starts
const MAX_VEL      = 120     // max seconds-per-second while dragging
const BASE_ACCEL   = 0.18    // base acceleration
const FAR_BOOST_AT = 220     // px from origin where extra acceleration starts
const FAR_ACCEL    = 0.32    // additional acceleration when cursor is far away

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}"${String(s % 60).padStart(2, '0')}'`
}

// ─── Component ────────────────────────────────────────────────────────────────
interface RulerProgressBarProps {
  currentPosition: number
  isPaused: boolean
  duration: number
  onSeek: (pos: number) => void
  interactive?: boolean
}

export function RulerProgressBar({
  currentPosition,
  isPaused,
  duration,
  onSeek,
  interactive = true,
}: RulerProgressBarProps) {
  const wrapRef   = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Live refs (no re-renders needed)
  const smoothRef    = useRef(currentPosition) // position displayed right now
  const syncRef      = useRef({ pos: currentPosition, time: performance.now(), paused: isPaused })
  const dragging     = useRef(false)
  const dragOriginX  = useRef(0)
  const mouseX       = useRef(0)
  const seekPos      = useRef(currentPosition)
  const propsRef     = useRef({ currentPosition, isPaused, duration, onSeek })
  const dprRef       = useRef(1)
  const audioCtxRef  = useRef<AudioContext | null>(null)
  const rightTimeRef = useRef<HTMLDivElement | null>(null)

  const ensureAudioCtx = useCallback(() => {
    if (typeof window === 'undefined') return null
    if (audioCtxRef.current) return audioCtxRef.current

    const Ctx = window.AudioContext
      ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return null

    audioCtxRef.current = new Ctx()
    return audioCtxRef.current
  }, [])

  const playScrubClicks = useCallback((count: number) => {
    const ctx = ensureAudioCtx()
    if (!ctx || count <= 0) return
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {})
    }

    // Limit burst to avoid audio overload on very fast scrubbing.
    const clicks = Math.min(count, 10)
    const t0 = ctx.currentTime

    for (let i = 0; i < clicks; i++) {
      const t = t0 + i * 0.011
      const osc = ctx.createOscillator()
      const filter = ctx.createBiquadFilter()
      const gain = ctx.createGain()

      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(2400, t)
      filter.type = 'highpass'
      filter.frequency.setValueAtTime(1200, t)
      filter.Q.setValueAtTime(1.2, t)
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.0008)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.012)

      osc.connect(filter)
      filter.connect(gain)
      gain.connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.014)
    }
  }, [ensureAudioCtx])

  // Keep props ref in sync
  useEffect(() => { propsRef.current = { currentPosition, isPaused, duration, onSeek } })

  // Sync playback position from parent
  useEffect(() => {
    if (!dragging.current) {
      syncRef.current = { pos: currentPosition, time: performance.now(), paused: isPaused }
      seekPos.current = currentPosition
    } else {
      syncRef.current.paused = isPaused
    }
  }, [currentPosition, isPaused])

  // ── Canvas draw (called every RAF frame) ───────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = dprRef.current
    const W   = canvas.width  / dpr
    const H   = RULER_H

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    const pos      = smoothRef.current
    const { duration } = propsRef.current
    const isDark   = document.documentElement.classList.contains('dark')

    const colTick  = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.50)'
    const colMinor = isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)'
    const colLabel = isDark ? 'rgba(255,255,255,0.32)' : 'rgba(0,0,0,0.32)'

    // Time range visible in the canvas
    const visStart = pos - INDICATOR_X / PX_PER_SEC
    const visEnd   = pos + (W - INDICATOR_X) / PX_PER_SEC
    const first    = Math.floor(visStart) - 1
    const last     = Math.ceil(visEnd)  + 1

    ctx.font = '10px ui-monospace, "SF Mono", monospace'

    for (let t = first; t <= last; t++) {
      if (t < 0) continue
      if (duration > 0 && t > duration + 2) continue

      const x     = INDICATOR_X + (t - pos) * PX_PER_SEC
      const major = t % 5 === 0

      // Tick bar
      ctx.fillStyle = major ? colTick : colMinor
      const h = major ? TICK_MAJOR_H : TICK_MINOR_H
      ctx.fillRect(Math.round(x) - (major ? 0.75 : 0.5), 0, major ? 1.5 : 1, h)

      // Time label to the RIGHT of the major tick
      if (major) {
        ctx.fillStyle = colLabel
        ctx.textAlign = 'left'
        ctx.fillText(fmtTime(t), x + LABEL_OFFSET, LABEL_BASELINE_Y)
      }
    }

    // ── Red playhead ──────────────────────────────────────────────────────
    const red = '#E8440F'
    // Shadow / glow
    ctx.save()
    ctx.shadowColor = 'rgba(232,68,15,0.45)'
    ctx.shadowBlur  = 7
    ctx.fillStyle   = red
    ctx.fillRect(INDICATOR_X - 1, 0, 2, H - 2)
    ctx.restore()

    // Current time label — right of playhead, at bottom
    const timeStr = fmtTime(smoothRef.current)
    ctx.font      = 'bold 10px ui-monospace, "SF Mono", monospace'
    ctx.fillStyle = red
    ctx.textAlign = 'left'
    ctx.fillText(timeStr, INDICATOR_X + 5, H - 3)

    // Remaining time label is rendered as an HTML overlay above gradient effects.
    if (duration > 0) {
      const remainStr = `-${fmtTime(Math.max(0, duration - smoothRef.current))}`
      if (rightTimeRef.current) {
        rightTimeRef.current.textContent = remainStr
      }
    } else if (rightTimeRef.current) {
      rightTimeRef.current.textContent = ''
    }
  }, [])

  // ── Main RAF loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    let raf: number
    let last = performance.now()

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now

      if (dragging.current) {
        // Velocity-based position update
        const prevSeek = seekPos.current
        const delta = mouseX.current - dragOriginX.current
        const abs   = Math.abs(delta)
        if (abs > DEAD_ZONE) {
          const baseSpeed = (abs - DEAD_ZONE) * BASE_ACCEL
          const farBoost = abs > FAR_BOOST_AT ? (abs - FAR_BOOST_AT) * FAR_ACCEL : 0
          const speed = Math.min(baseSpeed + farBoost, MAX_VEL)
          const dir   = delta > 0 ? 1 : -1
          const d     = propsRef.current.duration
          seekPos.current = Math.max(0, Math.min(d || Infinity, seekPos.current + dir * speed * dt))
        }
        smoothRef.current = seekPos.current

        // Click feedback for each crossed second while scrubbing.
        const crossedSeconds = Math.abs(Math.floor(seekPos.current) - Math.floor(prevSeek))
        if (crossedSeconds > 0) {
          playScrubClicks(crossedSeconds)
        }
      } else {
        // Smooth forward interpolation from last server sync
        const { pos, time, paused } = syncRef.current
        if (paused) {
          smoothRef.current = pos
        } else {
          const elapsed = (now - time) / 1000
          const d = propsRef.current.duration
          smoothRef.current = d > 0 ? Math.min(pos + elapsed, d) : pos + elapsed
        }
      }

      draw()
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [draw, playScrubClicks])

  useEffect(() => {
    return () => {
      audioCtxRef.current?.close().catch(() => {})
      audioCtxRef.current = null
    }
  }, [])

  // ── Canvas resize ──────────────────────────────────────────────────────────
  useEffect(() => {
    const wrap   = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    const resize = () => {
      const dpr  = window.devicePixelRatio || 1
      dprRef.current = dpr
      const cssW = wrap.offsetWidth
      canvas.width        = cssW * dpr
      canvas.height       = RULER_H * dpr
      canvas.style.width  = `${cssW}px`
      canvas.style.height = `${RULER_H}px`
    }

    const ro = new ResizeObserver(resize)
    ro.observe(wrap)
    resize()
    return () => ro.disconnect()
  }, [])

  // ── Drag events ────────────────────────────────────────────────────────────
  const stopDrag = useCallback(() => {
    dragging.current = false
    const { onSeek, duration } = propsRef.current
    onSeek(Math.max(0, Math.min(duration || Infinity, seekPos.current)))
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => { mouseX.current = e.clientX }
    const onUp   = () => { if (dragging.current) stopDrag() }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [stopDrag])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (!interactive) return
    e.preventDefault()
    ensureAudioCtx()?.resume().catch(() => {})
    dragging.current    = true
    dragOriginX.current = e.clientX
    mouseX.current      = e.clientX
    seekPos.current     = smoothRef.current
  }, [ensureAudioCtx, interactive])

  return (
    <div
      ref={wrapRef}
      className="relative w-full select-none overflow-hidden"
      style={{ height: RULER_H, cursor: interactive ? 'crosshair' : 'default' }}
      onMouseDown={onMouseDown}
    >
      <canvas ref={canvasRef} className="block" />
      <div
        className="pointer-events-none absolute inset-y-0 left-0 w-16"
        style={{ background: 'linear-gradient(90deg, var(--bg-elevated) 0%, rgba(0,0,0,0) 100%)' }}
      />
      <div
        className="pointer-events-none absolute inset-y-0 right-0 w-16"
        style={{ background: 'linear-gradient(270deg, var(--bg-elevated) 0%, rgba(0,0,0,0) 100%)' }}
      />
      <div
        ref={rightTimeRef}
        className="pointer-events-none absolute right-0 bottom-[3px] z-20 text-[10px] font-bold tabular-nums"
        style={{
          color: 'var(--text-muted)',
          fontFamily: 'ui-monospace, "SF Mono", monospace',
        }}
      />
    </div>
  )
}
