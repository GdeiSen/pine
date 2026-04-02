'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AudioConnectionState, AudioDiagnostics } from '@/stores/station.store'

const AUDIO_DEBUG_ENABLED =
  process.env.NEXT_PUBLIC_AUDIO_DEBUG === '1' || process.env.NEXT_PUBLIC_AUDIO_DEBUG === 'true'
const BUFFERING_GRACE_MS = 4_500
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 8_000
const HARD_RELOAD_EVERY_ATTEMPTS = 3
const VOLUME_FADE_IN_MS = 1200
const VOLUME_FADE_OUT_MS = 1200

export function normalizeTrackStartedAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

export function getServerOffsetMs(serverTime?: string | null, referenceTimeMs = Date.now()): number | null {
  if (!serverTime) return null
  const serverTimeMs = Date.parse(serverTime)
  if (Number.isNaN(serverTimeMs)) return null
  return serverTimeMs - referenceTimeMs
}

export function getEstimatedServerPosition(args: {
  currentPosition?: number
  duration?: number | null
  isPaused: boolean
  pausedPosition?: number
  serverOffsetMs: number | null
  trackStartedAt?: number | null
}) {
  const {
    currentPosition = 0,
    duration,
    isPaused,
    pausedPosition = 0,
    serverOffsetMs,
    trackStartedAt,
  } = args

  const clampPosition = (position: number) => {
    if (!Number.isFinite(position)) return 0
    const normalized = Math.max(0, position)
    if (typeof duration === 'number' && duration > 0) {
      return Math.min(normalized, duration)
    }
    return normalized
  }

  if (isPaused) {
    return clampPosition(pausedPosition || currentPosition)
  }

  if (typeof trackStartedAt === 'number' && Number.isFinite(trackStartedAt)) {
    const serverNowMs = Date.now() + (serverOffsetMs ?? 0)
    return clampPosition((serverNowMs - trackStartedAt) / 1000)
  }

  return clampPosition(currentPosition)
}

type UseRadioPlaybackEngineArgs = {
  streamUrl: string | null
  isPlaying: boolean
  volume: number
}

function isAutoplayBlock(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const name = 'name' in error ? String((error as { name?: unknown }).name ?? '') : ''
  return name === 'NotAllowedError' || name === 'AbortError'
}

function clampVolume(value: number) {
  if (!Number.isFinite(value)) return 1
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

export function useRadioPlaybackEngine({ streamUrl, isPlaying, volume }: UseRadioPlaybackEngineArgs) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const sourceUrlRef = useRef<string | null>(null)
  const mountedRef = useRef(false)
  const desiredRef = useRef({ streamUrl, isPlaying })
  const reconnectTimerRef = useRef<number | null>(null)
  const bufferingTimerRef = useRef<number | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const playTokenRef = useRef(0)
  const volumeFadeRafRef = useRef<number | null>(null)
  const volumeFadeTokenRef = useRef(0)
  const targetVolumeRef = useRef(clampVolume(volume))

  const [audioConnectionState, setAudioConnectionState] = useState<AudioConnectionState>('idle')
  const [audioConnectionMessage, setAudioConnectionMessage] = useState<string | null>(null)
  const [audioDiagnostics, setAudioDiagnostics] = useState<AudioDiagnostics | null>(null)
  const [audioNeedsRestart, setAudioNeedsRestart] = useState(false)

  const logDebug = useCallback((payload: Record<string, unknown>) => {
    if (!AUDIO_DEBUG_ENABLED) return
    // eslint-disable-next-line no-console
    console.debug('[audio]', payload)
  }, [])

  const setConnectionStatus = useCallback(
    (state: AudioConnectionState, message: string | null = null) => {
      if (!mountedRef.current) return
      setAudioConnectionState(state)
      setAudioConnectionMessage(message)
      if (state !== 'blocked') {
        setAudioNeedsRestart(false)
      }
      logDebug({ state, message, streamUrl: sourceUrlRef.current })
    },
    [logDebug],
  )

  const clearTimers = useCallback(() => {
    if (bufferingTimerRef.current !== null) {
      window.clearTimeout(bufferingTimerRef.current)
      bufferingTimerRef.current = null
    }
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  const stopVolumeFade = useCallback(() => {
    if (volumeFadeRafRef.current !== null) {
      window.cancelAnimationFrame(volumeFadeRafRef.current)
      volumeFadeRafRef.current = null
    }
    volumeFadeTokenRef.current += 1
  }, [])

  const fadeVolumeTo = useCallback(
    (target: number, durationMs: number, onComplete?: () => void) => {
      const audio = audioRef.current
      if (!audio) {
        onComplete?.()
        return
      }

      const clampedTarget = clampVolume(target)
      const startVolume = clampVolume(audio.volume)
      const duration = Math.max(0, durationMs)

      if (duration <= 0 || Math.abs(startVolume - clampedTarget) < 0.001) {
        audio.volume = clampedTarget
        onComplete?.()
        return
      }

      if (volumeFadeRafRef.current !== null) {
        window.cancelAnimationFrame(volumeFadeRafRef.current)
      }

      const token = ++volumeFadeTokenRef.current
      const startedAt = performance.now()

      const step = (now: number) => {
        if (!mountedRef.current || token !== volumeFadeTokenRef.current) return
        const currentAudio = audioRef.current
        if (!currentAudio) return

        const t = Math.max(0, Math.min(1, (now - startedAt) / duration))
        const eased = 1 - Math.pow(1 - t, 3)
        currentAudio.volume = clampVolume(
          startVolume + (clampedTarget - startVolume) * eased,
        )

        if (t < 1) {
          volumeFadeRafRef.current = window.requestAnimationFrame(step)
          return
        }

        volumeFadeRafRef.current = null
        onComplete?.()
      }

      volumeFadeRafRef.current = window.requestAnimationFrame(step)
    },
    [],
  )

  const fadeInToTargetVolume = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    const target = targetVolumeRef.current
    if (target <= 0) {
      audio.volume = 0
      return
    }
    fadeVolumeTo(target, VOLUME_FADE_IN_MS)
  }, [fadeVolumeTo])

  const attemptPlayback = useCallback(
    async (mode: 'normal' | 'reconnect' = 'normal') => {
      const audio = audioRef.current
      const desired = desiredRef.current
      if (!audio || !desired.streamUrl || !desired.isPlaying) return

      const token = ++playTokenRef.current
      const sourceChanged = sourceUrlRef.current !== desired.streamUrl
      const shouldHardReload =
        mode === 'reconnect' &&
        reconnectAttemptsRef.current > 0 &&
        reconnectAttemptsRef.current % HARD_RELOAD_EVERY_ATTEMPTS === 0

      if (sourceChanged) {
        sourceUrlRef.current = desired.streamUrl
        audio.pause()
        audio.src = desired.streamUrl
        audio.load()
      } else if (shouldHardReload) {
        audio.pause()
        audio.load()
      }

      setConnectionStatus(mode === 'reconnect' ? 'reconnecting' : 'connecting',
        mode === 'reconnect' ? 'Reconnecting stream...' : 'Connecting to stream...')

      try {
        stopVolumeFade()
        audio.volume = 0
        await audio.play()
        if (!mountedRef.current || token !== playTokenRef.current) return
        fadeInToTargetVolume()
        reconnectAttemptsRef.current = 0
        setAudioNeedsRestart(false)
        setConnectionStatus('playing', null)
      } catch (error) {
        if (!mountedRef.current || token !== playTokenRef.current) return

        if (isAutoplayBlock(error)) {
          setAudioNeedsRestart(true)
          setConnectionStatus('blocked', 'Browser blocked audio playback. Tap restart.')
          return
        }

        reconnectAttemptsRef.current += 1
        const delay = Math.min(
          RECONNECT_MAX_DELAY_MS,
          RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, reconnectAttemptsRef.current - 1),
        )
        setConnectionStatus('reconnecting', 'Reconnecting stream...')
        clearTimers()
        reconnectTimerRef.current = window.setTimeout(() => {
          if (!mountedRef.current || !desiredRef.current.streamUrl || !desiredRef.current.isPlaying) return
          void attemptPlayback('reconnect')
        }, delay)
      }
    },
    [clearTimers, fadeInToTargetVolume, setConnectionStatus, stopVolumeFade],
  )

  const reportDrift = useCallback(
    (sample: {
      targetPosition: number | null
      actualPosition: number | null
      syncType?: string | null
      rttMs?: number | null
    }) => {
      const driftMs =
        typeof sample.targetPosition === 'number' && typeof sample.actualPosition === 'number'
          ? Math.round((sample.actualPosition - sample.targetPosition) * 1000)
          : null
      const next: AudioDiagnostics = {
        driftMs,
        targetPosition: sample.targetPosition ?? null,
        actualPosition: sample.actualPosition ?? null,
        syncType: sample.syncType ?? null,
        rttMs: sample.rttMs ?? null,
        updatedAt: Date.now(),
      }
      if (mountedRef.current) {
        setAudioDiagnostics(next)
      }
      if (AUDIO_DEBUG_ENABLED) {
        logDebug({
          event: 'drift',
          ...next,
        })
      }
    },
    [logDebug],
  )

  useEffect(() => {
    mountedRef.current = true
    const audio = new Audio()
    audio.preload = 'auto'
    audio.volume = targetVolumeRef.current

    audioRef.current = audio

    const onPlaying = () => {
      clearTimers()
      reconnectAttemptsRef.current = 0
      setAudioNeedsRestart(false)
      setConnectionStatus('playing', null)
    }

    const onCanPlay = () => {
      const desired = desiredRef.current
      if (desired.isPlaying && !audio.paused) {
        setConnectionStatus('playing', null)
      }
    }

    const onWaiting = () => {
      const desired = desiredRef.current
      if (!desired.isPlaying) return
      if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return
      setConnectionStatus('buffering', 'Buffering stream...')
      clearTimers()
      bufferingTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current || !desiredRef.current.isPlaying || !desiredRef.current.streamUrl) return
        void attemptPlayback('reconnect')
      }, BUFFERING_GRACE_MS)
    }

    const onStalled = () => {
      const desired = desiredRef.current
      if (!desired.isPlaying) return
      if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return
      setConnectionStatus('buffering', 'Buffering stream...')
      clearTimers()
      bufferingTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current || !desiredRef.current.isPlaying || !desiredRef.current.streamUrl) return
        void attemptPlayback('reconnect')
      }, BUFFERING_GRACE_MS)
    }

    const onError = () => {
      const desired = desiredRef.current
      if (!desired.isPlaying) return
      setConnectionStatus('reconnecting', 'Reconnecting stream...')
      clearTimers()
      reconnectAttemptsRef.current += 1
      const delay = Math.min(
        RECONNECT_MAX_DELAY_MS,
        RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, reconnectAttemptsRef.current - 1),
      )
      reconnectTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current || !desiredRef.current.isPlaying || !desiredRef.current.streamUrl) return
        void attemptPlayback('reconnect')
      }, delay)
    }

    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('canplay', onCanPlay)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('stalled', onStalled)
    audio.addEventListener('error', onError)

    return () => {
      stopVolumeFade()
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('canplay', onCanPlay)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('stalled', onStalled)
      audio.removeEventListener('error', onError)
      clearTimers()
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audioRef.current = null
      sourceUrlRef.current = null
      mountedRef.current = false
      reconnectAttemptsRef.current = 0
      playTokenRef.current += 1
    }
  }, [attemptPlayback, clearTimers, setConnectionStatus, stopVolumeFade])

  useEffect(() => {
    targetVolumeRef.current = clampVolume(volume)
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      stopVolumeFade()
      audio.volume = targetVolumeRef.current
      return
    }
    audio.volume = targetVolumeRef.current
  }, [volume, stopVolumeFade])

  useEffect(() => {
    desiredRef.current = { streamUrl, isPlaying }
    clearTimers()

    const audio = audioRef.current
    if (!audio) return

    if (!streamUrl) {
      stopVolumeFade()
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      sourceUrlRef.current = null
      reconnectAttemptsRef.current = 0
      setAudioNeedsRestart(false)
      setConnectionStatus('idle', null)
      return
    }

    if (!isPlaying) {
      if (sourceUrlRef.current !== streamUrl) {
        sourceUrlRef.current = streamUrl
        audio.src = streamUrl
        audio.load()
      }

      const finishPause = () => {
        const currentAudio = audioRef.current
        if (!currentAudio) return
        if (desiredRef.current.isPlaying) return
        currentAudio.pause()
        currentAudio.volume = targetVolumeRef.current
        reconnectAttemptsRef.current = 0
        setAudioNeedsRestart(false)
      }

      if (!audio.paused && audio.volume > 0.001) {
        stopVolumeFade()
        fadeVolumeTo(0, VOLUME_FADE_OUT_MS, finishPause)
      } else {
        stopVolumeFade()
        finishPause()
      }
      setConnectionStatus('paused', null)
      return
    }

    void attemptPlayback('normal')
  }, [attemptPlayback, clearTimers, fadeVolumeTo, isPlaying, setConnectionStatus, stopVolumeFade, streamUrl])

  const restartAudio = useCallback(async () => {
    const audio = audioRef.current
    const desired = desiredRef.current
    if (!audio || !desired.streamUrl) return

    if (!desired.isPlaying) {
      desiredRef.current = { ...desired, isPlaying: true }
    }

    clearTimers()
    stopVolumeFade()
    sourceUrlRef.current = desired.streamUrl
    audio.src = desired.streamUrl
    audio.load()
    setAudioNeedsRestart(false)
    setConnectionStatus('connecting', 'Connecting to stream...')
    try {
      audio.volume = 0
      await audio.play()
      fadeInToTargetVolume()
      reconnectAttemptsRef.current = 0
      setConnectionStatus('playing', null)
    } catch (error) {
      if (isAutoplayBlock(error)) {
        setAudioNeedsRestart(true)
        setConnectionStatus('blocked', 'Browser blocked audio playback. Tap restart.')
        return
      }
      reconnectAttemptsRef.current += 1
      setConnectionStatus('reconnecting', 'Reconnecting stream...')
      reconnectTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current || !desiredRef.current.streamUrl || !desiredRef.current.isPlaying) return
        void attemptPlayback('reconnect')
      }, RECONNECT_BASE_DELAY_MS)
    }
  }, [attemptPlayback, clearTimers, fadeInToTargetVolume, setConnectionStatus, stopVolumeFade])

  const beginTransition = useCallback(() => {}, [])
  const beginCommandWait = useCallback(() => {}, [])
  const finishTransition = useCallback(() => {}, [])
  const isTransportTransitionActive = useCallback(() => false, [])

  return {
    audioNeedsRestart,
    audioConnectionState,
    audioConnectionMessage,
    audioDiagnostics,
    audioRef,
    beginTransition,
    beginCommandWait,
    finishTransition,
    isTransportTransitionActive,
    reportDrift,
    restartAudio,
  }
}
