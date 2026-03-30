'use client'

import { useRef, useEffect, useCallback } from 'react'

// ─── Constants ────────────────────────────────────────────────────────────────
const PX_PER_SEC   = 44      // pixels per second of audio
const INDICATOR_X_RATIO = 0.5 // playhead X ratio inside ruler (0..1)
const HIGHLIGHT_RADIUS_PX = 120 // distance around playhead for orange tint
const SUB_TICK_STEP_SEC = 0.2 // sub-second mini ticks (200ms)
const RULER_H      = 64      // total canvas height in CSS px
const LABEL_BASELINE_Y = 39  // y of ruler time text baseline
const LABEL_BOTTOM_Y   = 42  // approx lower edge of ruler time text
const TICK_MAJOR_H     = LABEL_BOTTOM_Y
const TICK_MINOR_H     = LABEL_BOTTOM_Y - 14
const TICK_MICRO_H     = LABEL_BOTTOM_Y - 22
const LABEL_OFFSET = 4       // gap between tick right edge and label
const DEAD_ZONE    = 12      // px dead zone before velocity starts
const MAX_VEL      = 120     // max seconds-per-second while dragging
const BASE_ACCEL   = 0.18    // base acceleration
const FAR_BOOST_AT = 220     // px from origin where extra acceleration starts
const FAR_ACCEL    = 0.32    // additional acceleration when cursor is far away
const TOGGLE_GUARD_WINDOW_MS = 1400
const TOGGLE_JUMP_CLAMP_S = 1.4
const PLAY_GUARD_AHEAD_MARGIN_S = 0.45
const SMOOTH_SNAP_THRESHOLD_S = 12
const SMOOTH_EPSILON_S = 0.008
const PLAY_FORWARD_BASE_SPS = 1.0
const PLAY_FORWARD_GAIN = 1.45
const PLAY_FORWARD_MAX_SPS = 3.6
const PLAY_BACKWARD_BASE_SPS = 0.12
const PLAY_BACKWARD_GAIN = 1.8
const PLAY_BACKWARD_MAX_SPS = 2.8
const PAUSED_FOLLOW_SPS = 2.8

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

type Rgba = { r: number; g: number; b: number; a: number }

function mixRgba(from: Rgba, to: Rgba, t: number): string {
  const k = Math.max(0, Math.min(1, t))
  const r = Math.round(from.r + (to.r - from.r) * k)
  const g = Math.round(from.g + (to.g - from.g) * k)
  const b = Math.round(from.b + (to.b - from.b) * k)
  const a = from.a + (to.a - from.a) * k
  return `rgba(${r},${g},${b},${a.toFixed(3)})`
}

function clampPosition(position: number, duration: number): number {
  const normalized = Math.max(0, position)
  return duration > 0 ? Math.min(normalized, duration) : normalized
}

function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (ctx.measureText(text).width <= maxWidth) return text
  const ellipsis = '…'
  if (ctx.measureText(ellipsis).width > maxWidth) return ''

  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const candidate = `${text.slice(0, mid)}${ellipsis}`
    if (ctx.measureText(candidate).width <= maxWidth) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return `${text.slice(0, lo)}${ellipsis}`
}

// ─── Component ────────────────────────────────────────────────────────────────
interface RulerProgressBarProps {
  currentPosition: number
  isPaused: boolean
  duration: number
  leftMeta?: string | null
  nextTrackHint?: string | null
  onSeek: (pos: number) => void
  interactive?: boolean
}

export function RulerProgressBar({
  currentPosition,
  isPaused,
  duration,
  leftMeta = null,
  nextTrackHint = null,
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
  const toggleGuardRef = useRef<{
    mode: 'pause' | 'play'
    startPos: number
    startTime: number
    activeUntil: number
  } | null>(null)
  const rightTimeRef = useRef<HTMLDivElement | null>(null)
  const leftTimeRef  = useRef<HTMLDivElement | null>(null)
  const leftMetaRef  = useRef<string | null>(leftMeta)
  const nextTrackHintRef = useRef<string | null>(nextTrackHint)

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
  useEffect(() => { leftMetaRef.current = leftMeta })
  useEffect(() => { nextTrackHintRef.current = nextTrackHint })

  // Sync playback position from parent
  useEffect(() => {
    if (!dragging.current) {
      const now = performance.now()
      const prev = syncRef.current
      const visualPos = smoothRef.current
      let nextPos = currentPosition
      const pausedChanged = prev.paused !== isPaused

      if (pausedChanged) {
        const deltaFromVisual = nextPos - visualPos
        if (isPaused) {
          if (Math.abs(deltaFromVisual) <= TOGGLE_JUMP_CLAMP_S) {
            nextPos = visualPos
          }
        } else {
          if (Math.abs(deltaFromVisual) <= TOGGLE_JUMP_CLAMP_S) {
            nextPos = visualPos
          }
        }
        toggleGuardRef.current = {
          mode: isPaused ? 'pause' : 'play',
          startPos: visualPos,
          startTime: now,
          activeUntil: now + TOGGLE_GUARD_WINDOW_MS,
        }
      } else {
        const guard = toggleGuardRef.current
        if (guard && now <= guard.activeUntil) {
          if (guard.mode === 'pause' && isPaused) {
            const rollback = guard.startPos - nextPos
            if (rollback > 0 && rollback <= TOGGLE_JUMP_CLAMP_S) {
              nextPos = guard.startPos
            }
          } else if (guard.mode === 'play' && !isPaused) {
            const elapsed = Math.max(0, (now - guard.startTime) / 1000)
            const maxExpected = guard.startPos + elapsed + PLAY_GUARD_AHEAD_MARGIN_S
            const forwardJump = nextPos - maxExpected
            const backwardJump = guard.startPos - nextPos
            if (forwardJump > 0 && forwardJump <= TOGGLE_JUMP_CLAMP_S) {
              nextPos = maxExpected
            } else if (backwardJump > 0 && backwardJump <= TOGGLE_JUMP_CLAMP_S) {
              nextPos = guard.startPos
            }
          } else {
            toggleGuardRef.current = null
          }
        } else if (guard && now > guard.activeUntil) {
          toggleGuardRef.current = null
        }
      }

      syncRef.current = { pos: nextPos, time: now, paused: isPaused }
      seekPos.current = nextPos
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
    const indicatorX = Math.round(W * INDICATOR_X_RATIO)

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    const pos      = smoothRef.current
    const { duration } = propsRef.current
    const isDark   = document.documentElement.classList.contains('dark')

    const tickMajorBase: Rgba = isDark
      ? { r: 255, g: 255, b: 255, a: 0.55 }
      : { r: 0, g: 0, b: 0, a: 0.50 }
    const tickMinorBase: Rgba = isDark
      ? { r: 255, g: 255, b: 255, a: 0.18 }
      : { r: 0, g: 0, b: 0, a: 0.18 }
    const tickMicroBase: Rgba = isDark
      ? { r: 255, g: 255, b: 255, a: 0.10 }
      : { r: 0, g: 0, b: 0, a: 0.10 }
    const labelBase: Rgba = isDark
      ? { r: 255, g: 255, b: 255, a: 0.32 }
      : { r: 0, g: 0, b: 0, a: 0.32 }
    const focusMajor: Rgba = isDark
      ? { r: 255, g: 255, b: 255, a: 0.92 }
      : { r: 0, g: 0, b: 0, a: 0.90 }
    const focusMinor: Rgba = isDark
      ? { r: 255, g: 255, b: 255, a: 0.68 }
      : { r: 0, g: 0, b: 0, a: 0.58 }
    const focusMicro: Rgba = isDark
      ? { r: 255, g: 255, b: 255, a: 0.36 }
      : { r: 0, g: 0, b: 0, a: 0.30 }
    const focusLabel: Rgba = isDark
      ? { r: 255, g: 255, b: 255, a: 0.90 }
      : { r: 0, g: 0, b: 0, a: 0.86 }

    // Time range visible in the canvas
    const visStart = pos - indicatorX / PX_PER_SEC
    const visEnd   = pos + (W - indicatorX) / PX_PER_SEC
    const first    = Math.floor(visStart) - 1
    const last     = Math.ceil(visEnd)  + 1

    ctx.font = '10px ui-monospace, "SF Mono", monospace'

    // Micro sub-second ticks (every 200ms), excluding full-second marks.
    const subFirst = Math.floor(visStart / SUB_TICK_STEP_SEC) - 1
    const subLast = Math.ceil(visEnd / SUB_TICK_STEP_SEC) + 1
    for (let i = subFirst; i <= subLast; i++) {
      const t = i * SUB_TICK_STEP_SEC
      if (t < 0) continue
      if (duration > 0 && t > duration) continue
      if (Math.abs(t - Math.round(t)) < 1e-6) continue

      const x = indicatorX + (t - pos) * PX_PER_SEC
      const dist = Math.abs(x - indicatorX)
      const glow = Math.max(0, 1 - dist / HIGHLIGHT_RADIUS_PX)

      ctx.fillStyle = mixRgba(tickMicroBase, focusMicro, glow)
      ctx.fillRect(Math.round(x) - 0.5, 0, 1, TICK_MICRO_H)
    }

    for (let t = first; t <= last; t++) {
      if (t < 0) continue
      if (duration > 0 && t > duration) continue

      const x     = indicatorX + (t - pos) * PX_PER_SEC
      const major = t % 5 === 0
      const dist = Math.abs(x - indicatorX)
      const glow = Math.max(0, 1 - dist / HIGHLIGHT_RADIUS_PX)

      // Tick bar
      ctx.fillStyle = major
        ? mixRgba(tickMajorBase, focusMajor, glow)
        : mixRgba(tickMinorBase, focusMinor, glow)
      const h = major ? TICK_MAJOR_H : TICK_MINOR_H
      ctx.fillRect(Math.round(x) - (major ? 0.75 : 0.5), 0, major ? 1.5 : 1, h)

      // Time label to the RIGHT of the major tick
      if (major) {
        ctx.fillStyle = mixRgba(labelBase, focusLabel, glow)
        ctx.textAlign = 'left'
        ctx.fillText(fmtTime(t), x + LABEL_OFFSET, LABEL_BASELINE_Y)
      }
    }

    const nextHint = nextTrackHintRef.current?.trim()
    if (duration > 0 && nextHint) {
      const endX = indicatorX + (duration - pos) * PX_PER_SEC
      if (Number.isFinite(endX) && endX > -220 && endX < W + 220) {
        const dist = Math.abs(endX - indicatorX)
        const glow = Math.max(0, 1 - dist / HIGHLIGHT_RADIUS_PX)
        const endLabelColor = mixRgba(labelBase, focusLabel, Math.min(1, glow * 0.85 + 0.2))

        ctx.fillStyle = mixRgba(tickMinorBase, focusMinor, Math.min(1, glow * 0.75 + 0.2))
        ctx.fillRect(Math.round(endX) - 0.5, 0, 1, TICK_MAJOR_H)

        const labelX = endX + LABEL_OFFSET + 2
        if (labelX < W - 4) {
          const maxWidth = Math.max(0, W - labelX - 4)
          if (maxWidth > 18) {
            ctx.font = '600 10px ui-monospace, "SF Mono", monospace'
            ctx.textAlign = 'left'
            ctx.fillStyle = endLabelColor
            const label = truncateToWidth(ctx, `→ ${nextHint}`, maxWidth)
            if (label) {
              ctx.fillText(label, labelX, LABEL_BASELINE_Y)
            }
          }
        }
      }
    }

    // ── Red playhead ──────────────────────────────────────────────────────
    const red = '#E8440F'
    // Shadow / glow
    ctx.save()
    ctx.shadowColor = 'rgba(232,68,15,0.45)'
    ctx.shadowBlur  = 7
    ctx.fillStyle   = red
    ctx.fillRect(indicatorX - 1, 0, 2, H - 16)
    ctx.restore()

    // Current time label — right of playhead, at bottom
    const timeStr = fmtTime(smoothRef.current)
    ctx.font      = 'bold 10px ui-monospace, "SF Mono", monospace'
    ctx.fillStyle = red
    ctx.textAlign = 'center'
    ctx.fillText(timeStr, indicatorX, H - 3)

    // Remaining time label is rendered as an HTML overlay above gradient effects.
    if (duration > 0) {
      const remainStr = `-${fmtTime(Math.max(0, duration - smoothRef.current))}`
      if (rightTimeRef.current) {
        rightTimeRef.current.textContent = remainStr
      }
    } else if (rightTimeRef.current) {
      rightTimeRef.current.textContent = ''
    }

    if (leftTimeRef.current) {
      leftTimeRef.current.textContent = leftMetaRef.current?.trim() ?? ''
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
        // Follow server-synced target with limited correction velocity to avoid visible jumps.
        const { pos, time, paused } = syncRef.current
        const duration = propsRef.current.duration
        const target = clampPosition(
          paused ? pos : pos + Math.max(0, (now - time) / 1000),
          duration,
        )
        const visual = smoothRef.current
        const diff = target - visual

        if (Math.abs(diff) >= SMOOTH_SNAP_THRESHOLD_S || Math.abs(diff) <= SMOOTH_EPSILON_S) {
          smoothRef.current = target
        } else if (paused) {
          const maxStep = PAUSED_FOLLOW_SPS * dt
          const step = Math.sign(diff) * Math.min(Math.abs(diff), maxStep)
          smoothRef.current = clampPosition(visual + step, duration)
        } else {
          const forwardDelta = Math.max(0, diff)
          const backwardDelta = Math.max(0, -diff)
          const forwardSpeed = Math.min(
            PLAY_FORWARD_MAX_SPS,
            PLAY_FORWARD_BASE_SPS + forwardDelta * PLAY_FORWARD_GAIN,
          )
          const backwardSpeed = Math.min(
            PLAY_BACKWARD_MAX_SPS,
            PLAY_BACKWARD_BASE_SPS + backwardDelta * PLAY_BACKWARD_GAIN,
          )
          const maxStep = diff >= 0 ? forwardSpeed * dt : backwardSpeed * dt
          const step = Math.sign(diff) * Math.min(Math.abs(diff), maxStep)
          smoothRef.current = clampPosition(visual + step, duration)
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
        ref={leftTimeRef}
        className="pointer-events-none absolute left-0 bottom-[3px] z-20 text-[10px] font-bold tabular-nums truncate max-w-[45%]"
        style={{
          color: 'var(--text-muted)',
          fontFamily: 'ui-monospace, "SF Mono", monospace',
        }}
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
