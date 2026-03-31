'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AudioConnectionState, AudioDiagnostics } from '@/stores/station.store'
import { resolveConfiguredOrigin } from '@/lib/origin'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '/api'
const MEDIA_BASE_URL = process.env.NEXT_PUBLIC_MEDIA_BASE_URL ?? ''
const DRIFT_THRESHOLD_S = 2.5
const DRIFT_CORRECTION_INTERVAL_MS = 5_000
const STRICT_ALIGN_THRESHOLD_S = 0.05
const SOFT_ALIGN_THRESHOLD_S = 0.35
const TRANSITION_GUARD_MS = 2_500
const RESUME_SYNC_GRACE_MS = 1_100
const RESUME_SYNC_SOFT_FORWARD_LIMIT_S = 1.15
const TRACK_START_STABILIZE_MS = 1_400
const TRACK_END_SEEK_GUARD_S = 0.4
const STALL_RECOVERY_DELAY_MS = 2_000
const STALL_RECOVERY_MAX_RETRIES = 3
const VOLUME_FADE_IN_MS = 1200
const VOLUME_FADE_OUT_MS = 1200

type UseDirectPlaybackEngineArgs = {
  trackId: string | null
  trackStartedAt: number | null
  currentPosition: number
  isPaused: boolean
  trackDuration: number
  volume: number
}

function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('access_token')
}

function buildStreamUrl(trackId: string): string {
  const token = getAccessToken()
  const backendOrigin = resolveConfiguredOrigin(MEDIA_BASE_URL)
  const base = backendOrigin
    ? `${backendOrigin}/api/tracks/${trackId}/stream`
    : `${API_URL}/tracks/${trackId}/stream`
  return token ? `${base}?access_token=${encodeURIComponent(token)}` : base
}

function normalizeMediaUrl(url: string): string {
  if (typeof window === 'undefined') return url
  try {
    return new URL(url, window.location.href).href
  } catch {
    return url
  }
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

export function useDirectPlaybackEngine({
  trackId,
  trackStartedAt,
  currentPosition,
  isPaused,
  trackDuration,
  volume,
}: UseDirectPlaybackEngineArgs) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const mountedRef = useRef(false)
  const currentTrackIdRef = useRef<string | null>(null)
  const sourceUrlRef = useRef<string | null>(null)
  const desiredStateRef = useRef({ trackId, isPaused })
  const playTokenRef = useRef(0)
  const driftTimerRef = useRef<number | null>(null)
  const pendingTargetPositionRef = useRef<number | null>(null)
  const transitionGuardRef = useRef<{ trackId: string | null; expiresAt: number } | null>(null)
  const transitionTimerRef = useRef<number | null>(null)
  const resumeSyncGraceUntilRef = useRef(0)
  const connectionStateRef = useRef<AudioConnectionState>('idle')
  const connectionMessageRef = useRef<string | null>(null)
  const needsRestartRef = useRef(false)
  const lastTrackLoadAtRef = useRef(0)
  const volumeFadeRafRef = useRef<number | null>(null)
  const volumeFadeTokenRef = useRef(0)
  const targetVolumeRef = useRef(clampVolume(volume))
  const isPausedRef = useRef(isPaused)
  const trackDurationRef = useRef(trackDuration)
  const stallRecoveryTimerRef = useRef<number | null>(null)
  const stallRecoveryAttemptsRef = useRef(0)

  const [audioConnectionState, setAudioConnectionState] = useState<AudioConnectionState>('idle')
  const [audioConnectionMessage, setAudioConnectionMessage] = useState<string | null>(null)
  const [audioDiagnostics, setAudioDiagnostics] = useState<AudioDiagnostics | null>(null)
  const [audioNeedsRestart, setAudioNeedsRestart] = useState(false)
  const [mediaDuration, setMediaDuration] = useState<number | null>(null)

  const setNeedsRestart = useCallback((value: boolean) => {
    if (!mountedRef.current) return
    if (needsRestartRef.current === value) return
    needsRestartRef.current = value
    setAudioNeedsRestart(value)
  }, [])

  const setConnectionStatus = useCallback(
    (state: AudioConnectionState, message: string | null = null) => {
      if (!mountedRef.current) return

      if (connectionStateRef.current !== state) {
        connectionStateRef.current = state
        setAudioConnectionState(state)
      }

      if (connectionMessageRef.current !== message) {
        connectionMessageRef.current = message
        setAudioConnectionMessage(message)
      }

      if (state !== 'blocked') {
        setNeedsRestart(false)
      }
    },
    [setNeedsRestart],
  )

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

  const getTargetPosition = useCallback((): number => {
    if (typeof currentPosition === 'number' && Number.isFinite(currentPosition) && (isPaused || !trackStartedAt)) {
      if (trackDuration > 0) return Math.min(Math.max(0, currentPosition), trackDuration)
      return Math.max(0, currentPosition)
    }

    if (!trackStartedAt) return -1
    const pos = (Date.now() - trackStartedAt) / 1000
    if (trackDuration > 0) return Math.min(Math.max(0, pos), trackDuration)
    return Math.max(0, pos)
  }, [currentPosition, isPaused, trackDuration, trackStartedAt])

  const getExpectedPosition = useCallback((): number => {
    return getTargetPosition()
  }, [getTargetPosition])

  useEffect(() => {
    desiredStateRef.current = { trackId, isPaused }
  }, [isPaused, trackId])

  useEffect(() => {
    isPausedRef.current = isPaused
    trackDurationRef.current = trackDuration
  }, [isPaused, trackDuration])

  const clearStallRecovery = useCallback((resetAttempts = false) => {
    if (stallRecoveryTimerRef.current !== null) {
      window.clearTimeout(stallRecoveryTimerRef.current)
      stallRecoveryTimerRef.current = null
    }
    if (resetAttempts) {
      stallRecoveryAttemptsRef.current = 0
    }
  }, [])

  const clearTransitionState = useCallback(() => {
    transitionGuardRef.current = null
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current)
      transitionTimerRef.current = null
    }
  }, [])

  const armResumeSyncGrace = useCallback(() => {
    resumeSyncGraceUntilRef.current = Date.now() + RESUME_SYNC_GRACE_MS
  }, [])

  const clearResumeSyncGrace = useCallback(() => {
    resumeSyncGraceUntilRef.current = 0
  }, [])

  const isResumeSyncGraceActive = useCallback(() => {
    return Date.now() < resumeSyncGraceUntilRef.current
  }, [])

  const isTransitionGuardActiveForTrack = useCallback(
    (id: string | null) => {
      const guard = transitionGuardRef.current
      if (!guard || !guard.trackId || !id || guard.trackId !== id) return false
      if (Date.now() > guard.expiresAt) {
        clearTransitionState()
        return false
      }
      return true
    },
    [clearTransitionState],
  )

  const applyTargetPosition = useCallback((targetPosition: number, mode: 'strict' | 'soft' = 'soft') => {
    const audio = audioRef.current
    if (!audio || audio.readyState < 1) return
    if (!Number.isFinite(targetPosition)) return

    const isPlaybackPaused = isPausedRef.current
    const currentTrackDuration = trackDurationRef.current
    if (
      mode === 'soft' &&
      !isPlaybackPaused &&
      Date.now() - lastTrackLoadAtRef.current < TRACK_START_STABILIZE_MS
    ) {
      return
    }

    const expected =
      currentTrackDuration > 0
        ? Math.min(Math.max(0, targetPosition), currentTrackDuration)
        : Math.max(0, targetPosition)
    const actual = audio.currentTime

    if (mode === 'strict') {
      if (Math.abs(actual - expected) > STRICT_ALIGN_THRESHOLD_S) {
        audio.currentTime = expected
      }
      return
    }

    if (
      isResumeSyncGraceActive() &&
      expected >= actual &&
      expected - actual <= RESUME_SYNC_SOFT_FORWARD_LIMIT_S
    ) {
      return
    }

    if (expected - actual > SOFT_ALIGN_THRESHOLD_S || actual - expected > DRIFT_THRESHOLD_S) {
      audio.currentTime = expected
    }
  }, [isResumeSyncGraceActive])

  const seekToExpectedPosition = useCallback(() => {
    const expected = getExpectedPosition()
    if (expected < 0) return
    applyTargetPosition(expected)
  }, [applyTargetPosition, getExpectedPosition])

  const startPlayback = useCallback(
    async (
      message = 'Resuming track...',
      options?: { withResumeGrace?: boolean; suppressConnectingPulse?: boolean },
    ) => {
      const audio = audioRef.current
      const desired = desiredStateRef.current
      if (!audio || !desired.trackId || desired.isPaused) return

      if (options?.withResumeGrace) {
        armResumeSyncGrace()
      }

      const token = ++playTokenRef.current
      const shouldShowConnecting =
        !options?.suppressConnectingPulse ||
        (connectionStateRef.current !== 'paused' && connectionStateRef.current !== 'playing')
      if (shouldShowConnecting) {
        setConnectionStatus('connecting', message)
      }

      try {
        stopVolumeFade()
        audio.volume = 0
        await audio.play()
        if (!mountedRef.current || token !== playTokenRef.current) return
        fadeInToTargetVolume()
        setConnectionStatus('playing', null)
      } catch (error) {
        if (!mountedRef.current || token !== playTokenRef.current) return
        if (isAutoplayBlock(error)) {
          setNeedsRestart(true)
          setConnectionStatus('blocked', 'Browser blocked audio playback. Tap restart.')
          return
        }
        setConnectionStatus('reconnecting', 'Failed to start track')
      }
    },
    [armResumeSyncGrace, fadeInToTargetVolume, setConnectionStatus, setNeedsRestart, stopVolumeFade],
  )

  const loadTrack = useCallback(
    (id: string, targetPosition: number) => {
      const audio = audioRef.current
      if (!audio) return

      const url = normalizeMediaUrl(buildStreamUrl(id))
      const sourceChanged = sourceUrlRef.current !== url

      const desired = desiredStateRef.current
      const normalizedTarget = Number.isFinite(targetPosition) ? Math.max(0, targetPosition) : 0
      let safeTarget = normalizedTarget
      const currentTrackDuration = trackDurationRef.current
      if (!desired.isPaused && currentTrackDuration > 0) {
        const bounded = Math.min(normalizedTarget, currentTrackDuration)
        safeTarget =
          bounded >= Math.max(currentTrackDuration - TRACK_END_SEEK_GUARD_S, 0)
            ? 0
            : bounded
      }

      pendingTargetPositionRef.current = safeTarget
      lastTrackLoadAtRef.current = Date.now()
      playTokenRef.current += 1
      clearTransitionState()
      clearResumeSyncGrace()
      clearStallRecovery(true)

      stopVolumeFade()
      audio.pause()

      if (sourceChanged) {
        setMediaDuration(null)
        audio.removeAttribute('src')
        audio.load()
        sourceUrlRef.current = url
        audio.src = url
        audio.preload = 'auto'
        audio.load()
      } else if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
        audio.load()
      }

      if (desired.trackId !== id) return

      if (desired.isPaused) {
        setConnectionStatus('paused', null)
        return
      }

      if (sourceChanged || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        setConnectionStatus('connecting', 'Loading track...')
        return
      }

      void startPlayback('Resuming track...')
    },
    [
      clearResumeSyncGrace,
      clearStallRecovery,
      clearTransitionState,
      setConnectionStatus,
      startPlayback,
      stopVolumeFade,
    ],
  )

  const scheduleStallRecovery = useCallback(
    (reason: 'waiting' | 'stalled' | 'error') => {
      const audio = audioRef.current
      const desired = desiredStateRef.current
      if (!audio || !desired.trackId || desired.isPaused) return
      if (stallRecoveryTimerRef.current !== null) return

      stallRecoveryTimerRef.current = window.setTimeout(() => {
        stallRecoveryTimerRef.current = null
        if (!mountedRef.current) return

        const currentAudio = audioRef.current
        const currentDesired = desiredStateRef.current
        if (!currentAudio || !currentDesired.trackId || currentDesired.isPaused) {
          clearStallRecovery(true)
          return
        }

        if (!currentAudio.paused && currentAudio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
          clearStallRecovery(true)
          return
        }

        const expectedPosition = getExpectedPosition()
        const targetPosition = expectedPosition >= 0 ? expectedPosition : 0

        if (stallRecoveryAttemptsRef.current >= STALL_RECOVERY_MAX_RETRIES - 1) {
          clearStallRecovery(true)
          setConnectionStatus('reconnecting', 'Reloading track...')
          void loadTrack(currentDesired.trackId, targetPosition)
          return
        }

        stallRecoveryAttemptsRef.current += 1
        pendingTargetPositionRef.current = targetPosition
        setConnectionStatus('reconnecting', 'Recovering playback...')
        currentAudio.load()
        void startPlayback('Recovering playback...', {
          withResumeGrace: true,
          suppressConnectingPulse: true,
        })
      }, STALL_RECOVERY_DELAY_MS)

      if (reason === 'error') {
        setConnectionStatus('reconnecting', 'Failed to load track')
      } else {
        setConnectionStatus('buffering', 'Buffering track...')
      }
    },
    [clearStallRecovery, getExpectedPosition, loadTrack, setConnectionStatus, startPlayback],
  )

  // Mount / unmount
  useEffect(() => {
    mountedRef.current = true
    const audio = new Audio()
    audio.preload = 'auto'
    audio.volume = targetVolumeRef.current
    ;(audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true
    audioRef.current = audio

    const alignPendingTarget = (mode: 'strict' | 'soft' = 'strict') => {
      const target = pendingTargetPositionRef.current
      if (target === null || !Number.isFinite(target)) return
      if (audio.readyState < HTMLMediaElement.HAVE_METADATA) return
      applyTargetPosition(target, mode)
      pendingTargetPositionRef.current = null
    }

    const updateMediaDuration = () => {
      const nextDuration =
        Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null
      setMediaDuration((prev) => (prev === nextDuration ? prev : nextDuration))
    }

    const hasExpectedSource = () => {
      const expected = sourceUrlRef.current
      if (!expected) return false
      const current = audio.currentSrc ? normalizeMediaUrl(audio.currentSrc) : ''
      return !!current && current === expected
    }

    const onLoadedMetadata = () => {
      if (!hasExpectedSource()) return
      updateMediaDuration()
      alignPendingTarget('strict')
    }

    const onCanPlay = () => {
      if (!hasExpectedSource()) return
      clearStallRecovery(true)
      alignPendingTarget('strict')
      const desired = desiredStateRef.current
      if (!desired.trackId) return
      if (desired.trackId !== currentTrackIdRef.current) return
      if (isTransitionGuardActiveForTrack(desired.trackId)) return
      if (desired.isPaused) {
        setConnectionStatus('paused', null)
        return
      }
      if (audio.paused) {
        void startPlayback('Loading track...')
      }
    }

    const onPlaying = () => {
      const desired = desiredStateRef.current
      if (!hasExpectedSource()) return
      clearStallRecovery(true)
      if (isTransitionGuardActiveForTrack(desired.trackId)) {
        audio.pause()
        setConnectionStatus('connecting', 'Switching track...')
        return
      }
      alignPendingTarget('soft')
      setConnectionStatus('playing', null)
    }

    const onWaiting = () => {
      const desired = desiredStateRef.current
      if (!desired.trackId || desired.isPaused) return
      scheduleStallRecovery('waiting')
    }

    const onStalled = () => {
      const desired = desiredStateRef.current
      if (!desired.trackId || desired.isPaused) return
      scheduleStallRecovery('stalled')
    }

    const onPause = () => {
      const desired = desiredStateRef.current
      if (!desired.trackId || !desired.isPaused) return
      clearStallRecovery(true)
      setConnectionStatus('paused', null)
    }

    const onError = () => {
      const desired = desiredStateRef.current
      if (!desired.trackId) return

      setAudioDiagnostics({
        driftMs: null,
        targetPosition: pendingTargetPositionRef.current,
        actualPosition: Number.isFinite(audio.currentTime) ? audio.currentTime : null,
        syncType: `media-error:${audio.error?.code ?? 'unknown'}`,
        rttMs: null,
        updatedAt: Date.now(),
      })

      if (desired.isPaused) {
        setConnectionStatus('paused', null)
        return
      }

      scheduleStallRecovery('error')
    }

    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('durationchange', updateMediaDuration)
    audio.addEventListener('canplay', onCanPlay)
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('stalled', onStalled)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('error', onError)

    return () => {
      mountedRef.current = false
      stopVolumeFade()
      setMediaDuration(null)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('durationchange', updateMediaDuration)
      audio.removeEventListener('canplay', onCanPlay)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('stalled', onStalled)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('error', onError)
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audioRef.current = null
      sourceUrlRef.current = null
      pendingTargetPositionRef.current = null
      clearTransitionState()
      clearResumeSyncGrace()
      clearStallRecovery(true)
      if (driftTimerRef.current !== null) {
        window.clearInterval(driftTimerRef.current)
        driftTimerRef.current = null
      }
    }
  }, [
    applyTargetPosition,
    clearResumeSyncGrace,
    clearStallRecovery,
    clearTransitionState,
    isTransitionGuardActiveForTrack,
    scheduleStallRecovery,
    setConnectionStatus,
    startPlayback,
    stopVolumeFade,
  ])

  // Volume
  useEffect(() => {
    targetVolumeRef.current = clampVolume(volume)
    const audio = audioRef.current
    if (!audio) return

    const target = targetVolumeRef.current
    if (audio.paused || desiredStateRef.current.isPaused) {
      stopVolumeFade()
      audio.volume = target
      return
    }

    audio.volume = target
  }, [volume, stopVolumeFade])

  // Track change — reload and seek
  useEffect(() => {
    if (!trackId) {
      currentTrackIdRef.current = null
      const audio = audioRef.current
      if (audio) {
        stopVolumeFade()
        setMediaDuration(null)
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
        sourceUrlRef.current = null
        pendingTargetPositionRef.current = null
        playTokenRef.current += 1
        clearTransitionState()
        clearResumeSyncGrace()
        clearStallRecovery(true)
        setConnectionStatus('idle', null)
      }
      return
    }

    if (trackId !== currentTrackIdRef.current) {
      currentTrackIdRef.current = trackId
      const nextTargetPosition = getExpectedPosition()
      void loadTrack(trackId, nextTargetPosition >= 0 ? nextTargetPosition : 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearResumeSyncGrace, clearStallRecovery, clearTransitionState, setConnectionStatus, stopVolumeFade, trackId])

  // Play/pause toggle (when track hasn't changed)
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !trackId || trackId !== currentTrackIdRef.current) return

    if (isPaused) {
      stopVolumeFade()
      fadeVolumeTo(0, VOLUME_FADE_OUT_MS, () => {
        const currentAudio = audioRef.current
        if (!currentAudio) return
        if (!desiredStateRef.current.isPaused) return
        currentAudio.pause()
        currentAudio.volume = targetVolumeRef.current
      })
      clearResumeSyncGrace()
      setConnectionStatus('paused', null)
    } else if (audio.paused) {
      const expectedPos = getExpectedPosition()
      const nextUrl = normalizeMediaUrl(buildStreamUrl(trackId))
      if (sourceUrlRef.current !== nextUrl || !!audio.error || !audio.currentSrc) {
        void loadTrack(trackId, expectedPos >= 0 ? expectedPos : 0)
        return
      }
      if (expectedPos >= 0) {
        pendingTargetPositionRef.current = expectedPos
        applyTargetPosition(expectedPos, 'soft')
      }
      void startPlayback('Resuming track...', {
        withResumeGrace: true,
        suppressConnectingPulse: true,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPaused])

  // Keep the direct audio element aligned with authoritative playback state.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !trackId || trackId !== currentTrackIdRef.current || audio.readyState < 1) return
    if (isPaused && !audio.paused) return

    const targetPosition = getTargetPosition()
    if (targetPosition < 0) return

    applyTargetPosition(targetPosition, isPaused ? 'strict' : 'soft')
  }, [applyTargetPosition, currentPosition, getTargetPosition, isPaused, trackId, trackStartedAt])

  // Periodic drift correction
  useEffect(() => {
    if (driftTimerRef.current !== null) {
      window.clearInterval(driftTimerRef.current)
      driftTimerRef.current = null
    }

    if (!trackId || isPaused) return

    driftTimerRef.current = window.setInterval(() => {
      const audio = audioRef.current
      if (!audio || audio.paused || audio.readyState < 3) return
      const expected = getExpectedPosition()
      if (expected < 0) return
      const actual = audio.currentTime
      const driftMs = (actual - expected) * 1000
      setAudioDiagnostics({
        driftMs,
        targetPosition: expected,
        actualPosition: actual,
        syncType: 'drift-correction',
        rttMs: null,
        updatedAt: Date.now(),
      })
      if (Math.abs(actual - expected) > DRIFT_THRESHOLD_S) {
        audio.currentTime = expected
      }
    }, DRIFT_CORRECTION_INTERVAL_MS)

    return () => {
      if (driftTimerRef.current !== null) {
        window.clearInterval(driftTimerRef.current)
        driftTimerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, isPaused, trackStartedAt])

  const restartAudio = useCallback(() => {
    if (!trackId) return
    clearTransitionState()
    clearResumeSyncGrace()
    const targetPosition = getExpectedPosition()
    void loadTrack(trackId, targetPosition >= 0 ? targetPosition : 0)
  }, [clearResumeSyncGrace, clearTransitionState, getExpectedPosition, loadTrack, trackId])

  const beginTransition = useCallback(
    (message = 'Switching track...') => {
      const transitionTrackId = desiredStateRef.current.trackId ?? currentTrackIdRef.current
      transitionGuardRef.current = {
        trackId: transitionTrackId,
        expiresAt: Date.now() + TRANSITION_GUARD_MS,
      }
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current)
      }
      transitionTimerRef.current = window.setTimeout(() => {
        const guard = transitionGuardRef.current
        if (!guard) return
        const desired = desiredStateRef.current
        const shouldResume = guard.trackId !== null && desired.trackId === guard.trackId && !desired.isPaused
        clearTransitionState()
        if (shouldResume) {
          void startPlayback('Resuming track...', { withResumeGrace: true })
        }
      }, TRANSITION_GUARD_MS)
      playTokenRef.current += 1
      clearResumeSyncGrace()
      clearStallRecovery(true)
      const audio = audioRef.current
      if (audio) {
        stopVolumeFade()
        audio.pause()
      }
      setConnectionStatus('connecting', message)
    },
    [
      clearResumeSyncGrace,
      clearStallRecovery,
      clearTransitionState,
      setConnectionStatus,
      startPlayback,
      stopVolumeFade,
    ],
  )

  const reportDrift = useCallback(
    (args: { targetPosition: number; actualPosition: number | null; syncType: string; rttMs: number | null }) => {
      const audio = audioRef.current
      const pauseFadeInFlight = isPaused && !!audio && !audio.paused
      if (!pauseFadeInFlight && audio && audio.readyState >= 1 && Number.isFinite(args.targetPosition)) {
        const syncType = args.syncType.toLowerCase()
        const strictSync =
          isPaused ||
          syncType === 'command:pause' ||
          (syncType === 'command:seek' && isPaused)
        applyTargetPosition(args.targetPosition, strictSync ? 'strict' : 'soft')
      } else if (!pauseFadeInFlight) {
        // Fall back to the engine state if the sync sample does not carry a usable target.
        seekToExpectedPosition()
      }
      if (args.actualPosition !== null) {
        setAudioDiagnostics({
          driftMs: (args.actualPosition - args.targetPosition) * 1000,
          targetPosition: args.targetPosition,
          actualPosition: args.actualPosition,
          syncType: args.syncType,
          rttMs: args.rttMs,
          updatedAt: Date.now(),
        })
      }
    },
    [applyTargetPosition, isPaused, seekToExpectedPosition],
  )

  return {
    audioRef,
    mediaDuration,
    audioConnectionState,
    audioConnectionMessage,
    audioDiagnostics,
    audioNeedsRestart,
    beginTransition,
    restartAudio,
    reportDrift,
  }
}
