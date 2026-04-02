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
const RESUME_SYNC_GRACE_MS = 1_100
const RESUME_SYNC_SOFT_FORWARD_LIMIT_S = 1.15
const TRACK_START_STABILIZE_MS = 3_200
const TRACK_OPENING_GRACE_S = 3
const TRACK_END_SEEK_GUARD_S = 0.4
const SEEK_TRANSITION_THRESHOLD_S = 0.9
const STALL_RECOVERY_DELAY_MS = 5_500
const TRACK_OPEN_RECOVERY_GRACE_MS = 12_000
const STALL_RECOVERY_MAX_RETRIES = 2
const VOLUME_FADE_IN_MS = 1600
const VOLUME_FADE_OUT_MS = 380
const SEEK_FADE_OUT_MS = 220
const PREFETCH_CLEANUP_DELAY_MS = 1_000
const TRANSPORT_TRANSITION_MAX_MS = 10_000

type DirectTransportPhase = 'idle' | 'pause' | 'track-change' | 'seek'

type UseDirectPlaybackEngineArgs = {
  trackId: string | null
  prefetchTrackId?: string | null
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
  return name === 'NotAllowedError'
}

function isPlaybackAbort(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const name = 'name' in error ? String((error as { name?: unknown }).name ?? '') : ''
  return name === 'AbortError'
}

function isAuthoritativeDirectSyncType(syncType: string) {
  return (
    syncType === 'command:play' ||
    syncType === 'command:pause' ||
    syncType === 'command:seek' ||
    syncType === 'reconnect' ||
    syncType === 'manual-resync' ||
    syncType === 'manual-restart' ||
    syncType === 'recovery'
  )
}

function clampVolume(value: number) {
  if (!Number.isFinite(value)) return 1
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

export function useDirectPlaybackEngine({
  trackId,
  prefetchTrackId = null,
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
  const currentPositionRef = useRef(currentPosition)
  const trackStartedAtRef = useRef(trackStartedAt)
  const stallRecoveryTimerRef = useRef<number | null>(null)
  const stallRecoveryAttemptsRef = useRef(0)
  const sourcePlaybackStartedRef = useRef(false)
  const prefetchAudioRef = useRef<HTMLAudioElement | null>(null)
  const prefetchUrlRef = useRef<string | null>(null)
  const transportTransitionRef = useRef<{
    token: number
    phase: DirectTransportPhase
    trackId: string | null
    expiresAt: number
  }>({
    token: 0,
    phase: 'idle',
    trackId: null,
    expiresAt: 0,
  })

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
    const liveCurrentPosition = currentPositionRef.current
    const liveTrackStartedAt = trackStartedAtRef.current
    const liveTrackDuration = trackDurationRef.current

    if (typeof liveCurrentPosition === 'number' && Number.isFinite(liveCurrentPosition)) {
      if (liveTrackDuration > 0) {
        return Math.min(Math.max(0, liveCurrentPosition), liveTrackDuration)
      }
      return Math.max(0, liveCurrentPosition)
    }

    if (!liveTrackStartedAt) return -1
    const pos = (Date.now() - liveTrackStartedAt) / 1000
    if (liveTrackDuration > 0) return Math.min(Math.max(0, pos), liveTrackDuration)
    return Math.max(0, pos)
  }, [])

  const getExpectedPosition = useCallback((): number => {
    return getTargetPosition()
  }, [getTargetPosition])

  useEffect(() => {
    desiredStateRef.current = { trackId, isPaused }
  }, [isPaused, trackId])

  useEffect(() => {
    isPausedRef.current = isPaused
    trackDurationRef.current = trackDuration
    currentPositionRef.current = currentPosition
    trackStartedAtRef.current = trackStartedAt
  }, [currentPosition, isPaused, trackDuration, trackStartedAt])

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

  const finishTransportTransition = useCallback((token?: number) => {
    const transition = transportTransitionRef.current
    if (transition.phase === 'idle') return
    if (typeof token === 'number' && transition.token !== token) return
    transportTransitionRef.current = {
      token: transition.token,
      phase: 'idle',
      trackId: null,
      expiresAt: 0,
    }
  }, [])

  const isTransportTransitionActive = useCallback(() => {
    const transition = transportTransitionRef.current
    if (transition.phase === 'idle') return false
    if (Date.now() <= transition.expiresAt) return true
    finishTransportTransition(transition.token)
    return false
  }, [finishTransportTransition])

  const getTransportTransitionPhase = useCallback((): DirectTransportPhase => {
    if (!isTransportTransitionActive()) return 'idle'
    return transportTransitionRef.current.phase
  }, [isTransportTransitionActive])

  const isTransportTransitionTokenCurrent = useCallback(
    (token: number) => {
      if (!isTransportTransitionActive()) return false
      return transportTransitionRef.current.token === token
    },
    [isTransportTransitionActive],
  )

  const beginTransportTransition = useCallback(
    (phase: DirectTransportPhase, trackIdForTransition?: string | null) => {
      stopVolumeFade()
      const nextToken = transportTransitionRef.current.token + 1
      transportTransitionRef.current = {
        token: nextToken,
        phase,
        trackId: trackIdForTransition ?? desiredStateRef.current.trackId ?? currentTrackIdRef.current,
        expiresAt: Date.now() + TRANSPORT_TRANSITION_MAX_MS,
      }
      return nextToken
    },
    [stopVolumeFade],
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
          finishTransportTransition()
          setNeedsRestart(true)
          setConnectionStatus('blocked', 'Browser blocked audio playback. Tap restart.')
          return
        }
        if (isPlaybackAbort(error)) {
          setConnectionStatus('connecting', message)
          return
        }
        setConnectionStatus('reconnecting', 'Failed to start track')
      }
    },
    [
      armResumeSyncGrace,
      fadeInToTargetVolume,
      finishTransportTransition,
      setConnectionStatus,
      setNeedsRestart,
      stopVolumeFade,
    ],
  )

  const beginCommandWait = useCallback(
    (message = 'Waiting for server confirmation...') => {
      playTokenRef.current += 1
      clearResumeSyncGrace()
      clearStallRecovery(true)
      setConnectionStatus('connecting', message)
    },
    [clearResumeSyncGrace, clearStallRecovery, setConnectionStatus],
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
      if (!sourceChanged && !desired.isPaused && currentTrackDuration > 0) {
        const bounded = Math.min(normalizedTarget, currentTrackDuration)
        safeTarget =
          bounded >= Math.max(currentTrackDuration - TRACK_END_SEEK_GUARD_S, 0)
            ? 0
            : bounded
      }
      pendingTargetPositionRef.current = safeTarget
      lastTrackLoadAtRef.current = Date.now()
      sourcePlaybackStartedRef.current = false
      playTokenRef.current += 1
      clearTransitionState()
      clearResumeSyncGrace()
      clearStallRecovery(true)

      stopVolumeFade()
      audio.pause()

      if (sourceChanged) {
        setMediaDuration(null)
        sourceUrlRef.current = url
        audio.volume = 0
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

  const performPauseTransition = useCallback(
    (targetPosition: number) => {
      const normalizedTarget = Number.isFinite(targetPosition) ? Math.max(0, targetPosition) : 0
      const audio = audioRef.current

      pendingTargetPositionRef.current = normalizedTarget
      clearResumeSyncGrace()
      clearStallRecovery(true)

      const finalizePause = (token: number) => {
        if (!isTransportTransitionTokenCurrent(token)) return
        const currentAudio = audioRef.current
        if (!currentAudio) return

        if (!desiredStateRef.current.isPaused) {
          currentAudio.volume = targetVolumeRef.current
          finishTransportTransition(token)
          return
        }

        currentAudio.pause()
        if (currentAudio.readyState >= 1) {
          applyTargetPosition(normalizedTarget, 'strict')
          pendingTargetPositionRef.current = null
        }
        currentAudio.volume = targetVolumeRef.current
        setConnectionStatus('paused', null)
        finishTransportTransition(token)
      }

      const token = beginTransportTransition('pause')

      if (!audio || audio.paused || audio.readyState < HTMLMediaElement.HAVE_METADATA) {
        finalizePause(token)
        return
      }

      setConnectionStatus('buffering', 'Pausing track...')
      fadeVolumeTo(0, VOLUME_FADE_OUT_MS, () => {
        finalizePause(token)
      })
    },
    [
      applyTargetPosition,
      beginTransportTransition,
      clearResumeSyncGrace,
      clearStallRecovery,
      fadeVolumeTo,
      finishTransportTransition,
      isTransportTransitionTokenCurrent,
      setConnectionStatus,
    ],
  )

  const performTrackSwitch = useCallback(
    (id: string, targetPosition: number) => {
      const normalizedTarget = Number.isFinite(targetPosition) ? Math.max(0, targetPosition) : 0
      const audio = audioRef.current

      clearResumeSyncGrace()
      clearStallRecovery(true)
      const token = beginTransportTransition('track-change', id)

      const switchSource = () => {
        if (!isTransportTransitionTokenCurrent(token)) return
        void loadTrack(id, normalizedTarget)
      }

      if (
        !audio ||
        audio.paused ||
        audio.readyState < HTMLMediaElement.HAVE_METADATA ||
        !sourcePlaybackStartedRef.current
      ) {
        switchSource()
        return
      }

      setConnectionStatus('connecting', 'Switching track...')
      fadeVolumeTo(0, VOLUME_FADE_OUT_MS, switchSource)
    },
    [
      beginTransportTransition,
      clearResumeSyncGrace,
      clearStallRecovery,
      fadeVolumeTo,
      isTransportTransitionTokenCurrent,
      loadTrack,
      setConnectionStatus,
    ],
  )

  const performSeekTransition = useCallback(
    (targetPosition: number) => {
      const audio = audioRef.current
      if (!audio || !Number.isFinite(targetPosition)) return

      const normalizedTarget = Math.max(0, targetPosition)
      pendingTargetPositionRef.current = normalizedTarget
      clearStallRecovery(true)

      if (isPausedRef.current || audio.paused || audio.readyState < HTMLMediaElement.HAVE_METADATA) {
        applyTargetPosition(normalizedTarget, 'strict')
        pendingTargetPositionRef.current = null
        return
      }

      const token = beginTransportTransition('seek')

      const finishSeek = () => {
        if (!isTransportTransitionTokenCurrent(token)) return
        const currentAudio = audioRef.current
        if (!currentAudio) return

        currentAudio.currentTime = normalizedTarget
        pendingTargetPositionRef.current = null
        armResumeSyncGrace()
        currentAudio.volume = 0
        fadeInToTargetVolume()
        setConnectionStatus('playing', null)
        finishTransportTransition(token)
      }

      setConnectionStatus('buffering', 'Synchronizing playback...')
      fadeVolumeTo(0, SEEK_FADE_OUT_MS, finishSeek)
    },
    [
      applyTargetPosition,
      armResumeSyncGrace,
      beginTransportTransition,
      clearStallRecovery,
      fadeInToTargetVolume,
      fadeVolumeTo,
      finishTransportTransition,
      isTransportTransitionTokenCurrent,
      setConnectionStatus,
    ],
  )

  const scheduleStallRecovery = useCallback(
    (reason: 'waiting' | 'stalled' | 'error') => {
      const audio = audioRef.current
      const desired = desiredStateRef.current
      if (!audio || !desired.trackId || desired.isPaused) return
      if (isTransportTransitionActive()) return
      if (stallRecoveryTimerRef.current !== null) return

      const openingTrack = !sourcePlaybackStartedRef.current
      const sinceTrackLoadMs = Date.now() - lastTrackLoadAtRef.current
      const recoveryDelayMs = openingTrack
        ? Math.max(TRACK_OPEN_RECOVERY_GRACE_MS - sinceTrackLoadMs, 250)
        : STALL_RECOVERY_DELAY_MS

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

        if (reason === 'error') {
          if (stallRecoveryAttemptsRef.current >= STALL_RECOVERY_MAX_RETRIES - 1) {
            clearStallRecovery(true)
            setConnectionStatus('reconnecting', 'Reloading track...')
            void loadTrack(currentDesired.trackId, targetPosition)
            return
          }

          stallRecoveryAttemptsRef.current += 1
          setConnectionStatus('reconnecting', 'Retrying track...')
          void startPlayback('Retrying track...', {
            withResumeGrace: true,
            suppressConnectingPulse: true,
          })
          return
        }

        if (openingTrack && currentAudio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          stallRecoveryAttemptsRef.current = 0
          void startPlayback('Loading track...', {
            withResumeGrace: true,
            suppressConnectingPulse: true,
          })
          return
        }

        if (stallRecoveryAttemptsRef.current >= STALL_RECOVERY_MAX_RETRIES - 1) {
          clearStallRecovery(true)
          setConnectionStatus('buffering', 'Waiting for buffered audio...')
          return
        }

        stallRecoveryAttemptsRef.current += 1
        setConnectionStatus('reconnecting', 'Recovering playback...')
        pendingTargetPositionRef.current = targetPosition
        void startPlayback('Recovering playback...', {
          withResumeGrace: true,
          suppressConnectingPulse: true,
        })
      }, recoveryDelayMs)

      if (reason === 'error') {
        setConnectionStatus('reconnecting', 'Failed to load track')
      } else {
        setConnectionStatus(
          openingTrack ? 'connecting' : 'buffering',
          openingTrack ? 'Loading track...' : 'Buffering track...',
        )
      }
    },
    [
      clearStallRecovery,
      getExpectedPosition,
      isTransportTransitionActive,
      loadTrack,
      setConnectionStatus,
      startPlayback,
    ],
  )

  const engineCallbacksRef = useRef({
    applyTargetPosition,
    clearResumeSyncGrace,
    clearStallRecovery,
    clearTransitionState,
    finishTransportTransition,
    getTransportTransitionPhase,
    isTransitionGuardActiveForTrack,
    isTransportTransitionActive,
    scheduleStallRecovery,
    setConnectionStatus,
    startPlayback,
    stopVolumeFade,
  })

  useEffect(() => {
    engineCallbacksRef.current = {
      applyTargetPosition,
      clearResumeSyncGrace,
      clearStallRecovery,
      clearTransitionState,
      finishTransportTransition,
      getTransportTransitionPhase,
      isTransitionGuardActiveForTrack,
      isTransportTransitionActive,
      scheduleStallRecovery,
      setConnectionStatus,
      startPlayback,
      stopVolumeFade,
    }
  }, [
    applyTargetPosition,
    clearResumeSyncGrace,
    clearStallRecovery,
    clearTransitionState,
    finishTransportTransition,
    getTransportTransitionPhase,
    isTransitionGuardActiveForTrack,
    isTransportTransitionActive,
    scheduleStallRecovery,
    setConnectionStatus,
    startPlayback,
    stopVolumeFade,
  ])

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
      engineCallbacksRef.current.applyTargetPosition(target, mode)
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
      engineCallbacksRef.current.clearStallRecovery(true)
      alignPendingTarget('strict')
      const desired = desiredStateRef.current
      if (!desired.trackId) return
      if (desired.trackId !== currentTrackIdRef.current) return
      if (engineCallbacksRef.current.isTransitionGuardActiveForTrack(desired.trackId)) return
      if (desired.isPaused) {
        engineCallbacksRef.current.setConnectionStatus('paused', null)
        return
      }
      if (audio.paused) {
        void engineCallbacksRef.current.startPlayback('Loading track...')
      }
    }

    const onPlaying = () => {
      const desired = desiredStateRef.current
      if (!hasExpectedSource()) return
      sourcePlaybackStartedRef.current = true
      engineCallbacksRef.current.clearStallRecovery(true)
      const transportPhase = engineCallbacksRef.current.getTransportTransitionPhase()
      if (engineCallbacksRef.current.isTransitionGuardActiveForTrack(desired.trackId)) {
        audio.pause()
        engineCallbacksRef.current.setConnectionStatus('connecting', 'Switching track...')
        return
      }
      alignPendingTarget('soft')
      engineCallbacksRef.current.setConnectionStatus('playing', null)
      if (transportPhase === 'track-change' || transportPhase === 'seek') {
        engineCallbacksRef.current.finishTransportTransition()
      }
    }

    const onWaiting = () => {
      const desired = desiredStateRef.current
      if (!desired.trackId || desired.isPaused) return
      engineCallbacksRef.current.scheduleStallRecovery('waiting')
    }

    const onStalled = () => {
      const desired = desiredStateRef.current
      if (!desired.trackId || desired.isPaused) return
      engineCallbacksRef.current.scheduleStallRecovery('stalled')
    }

    const onPause = () => {
      const desired = desiredStateRef.current
      const transportPhase = engineCallbacksRef.current.getTransportTransitionPhase()
      if (!desired.trackId || (!desired.isPaused && transportPhase !== 'pause')) return
      engineCallbacksRef.current.clearStallRecovery(true)
      alignPendingTarget('strict')
      audio.volume = targetVolumeRef.current
      engineCallbacksRef.current.setConnectionStatus('paused', null)
      if (transportPhase === 'pause') {
        engineCallbacksRef.current.finishTransportTransition()
      }
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
        engineCallbacksRef.current.setConnectionStatus('paused', null)
        return
      }

      engineCallbacksRef.current.scheduleStallRecovery('error')
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
      engineCallbacksRef.current.stopVolumeFade()
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
      const prefetchedAudio = prefetchAudioRef.current
      if (prefetchedAudio) {
        prefetchedAudio.pause()
        prefetchedAudio.removeAttribute('src')
        prefetchedAudio.load()
      }
      audioRef.current = null
      prefetchAudioRef.current = null
      prefetchUrlRef.current = null
      sourceUrlRef.current = null
      pendingTargetPositionRef.current = null
      engineCallbacksRef.current.finishTransportTransition()
      engineCallbacksRef.current.clearTransitionState()
      engineCallbacksRef.current.clearResumeSyncGrace()
      engineCallbacksRef.current.clearStallRecovery(true)
      if (driftTimerRef.current !== null) {
        window.clearInterval(driftTimerRef.current)
        driftTimerRef.current = null
      }
    }
  }, [])

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

  useEffect(() => {
    const nextTrackId = prefetchTrackId?.trim() ?? ''
    if (!nextTrackId || nextTrackId === trackId) {
      const existing = prefetchAudioRef.current
      prefetchAudioRef.current = null
      prefetchUrlRef.current = null
      if (existing) {
        existing.pause()
        existing.removeAttribute('src')
        existing.load()
      }
      return
    }

    const nextUrl = normalizeMediaUrl(buildStreamUrl(nextTrackId))
    if (prefetchUrlRef.current === nextUrl) {
      return
    }

    const prefetchAudio = new Audio()
    prefetchAudio.preload = 'auto'
    prefetchAudio.src = nextUrl
    prefetchAudio.load()

    const previous = prefetchAudioRef.current
    prefetchAudioRef.current = prefetchAudio
    prefetchUrlRef.current = nextUrl

    if (previous) {
      window.setTimeout(() => {
        previous.pause()
        previous.removeAttribute('src')
        previous.load()
      }, PREFETCH_CLEANUP_DELAY_MS)
    }

    return () => {
      if (prefetchAudioRef.current !== prefetchAudio) return
      prefetchAudioRef.current = null
      prefetchUrlRef.current = null
      prefetchAudio.pause()
      prefetchAudio.removeAttribute('src')
      prefetchAudio.load()
    }
  }, [prefetchTrackId, trackId])

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
        sourcePlaybackStartedRef.current = false
        finishTransportTransition()
        clearTransitionState()
        clearResumeSyncGrace()
        clearStallRecovery(true)
        setConnectionStatus('idle', null)
      }
      return
    }

    if (trackId !== currentTrackIdRef.current) {
      const previousTrackId = currentTrackIdRef.current
      currentTrackIdRef.current = trackId
      const nextTargetPosition = getExpectedPosition()
      const safeTargetPosition = nextTargetPosition >= 0 ? nextTargetPosition : 0
      if (previousTrackId) {
        void performTrackSwitch(trackId, safeTargetPosition)
      } else {
        void loadTrack(trackId, safeTargetPosition)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    clearResumeSyncGrace,
    clearStallRecovery,
    clearTransitionState,
    finishTransportTransition,
    loadTrack,
    performTrackSwitch,
    setConnectionStatus,
    stopVolumeFade,
    trackId,
  ])

  // Play/pause toggle (when track hasn't changed)
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !trackId || trackId !== currentTrackIdRef.current) return

    if (isPaused) {
      const expectedPos = getExpectedPosition()
      performPauseTransition(
        expectedPos >= 0
          ? expectedPos
          : Number.isFinite(audio.currentTime)
            ? Math.max(0, audio.currentTime)
            : 0,
      )
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
  }, [getExpectedPosition, isPaused, performPauseTransition, startPlayback, trackId])

  // Keep the direct audio element aligned with authoritative playback state.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !trackId || trackId !== currentTrackIdRef.current || audio.readyState < 1) return
    if (isTransportTransitionActive()) return
    if (isPaused && !audio.paused) return

    const targetPosition = getTargetPosition()
    if (targetPosition < 0) return

    if (!isPaused && !audio.paused && sourcePlaybackStartedRef.current) {
      const actualPosition = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0
      if (Math.abs(actualPosition - targetPosition) >= SEEK_TRANSITION_THRESHOLD_S) {
        performSeekTransition(targetPosition)
        return
      }
    }

    applyTargetPosition(targetPosition, isPaused ? 'strict' : 'soft')
  }, [
    applyTargetPosition,
    currentPosition,
    getTargetPosition,
    isPaused,
    isTransportTransitionActive,
    performSeekTransition,
    trackId,
    trackStartedAt,
  ])

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
      if (!sourcePlaybackStartedRef.current) return
      if (connectionStateRef.current !== 'playing') return
      if (isTransportTransitionActive()) return
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
  }, [getExpectedPosition, isPaused, isTransportTransitionActive, trackId])

  const restartAudio = useCallback(() => {
    if (!trackId) return
    finishTransportTransition()
    clearTransitionState()
    clearResumeSyncGrace()
    const targetPosition = getExpectedPosition()
    const audio = audioRef.current
    const expectedUrl = normalizeMediaUrl(buildStreamUrl(trackId))

    if (audio && sourceUrlRef.current === expectedUrl && audio.currentSrc) {
      pendingTargetPositionRef.current = targetPosition >= 0 ? targetPosition : 0
      applyTargetPosition(pendingTargetPositionRef.current, 'strict')
      void startPlayback('Restarting track...', {
        withResumeGrace: true,
        suppressConnectingPulse: false,
      })
      return
    }

    void loadTrack(trackId, targetPosition >= 0 ? targetPosition : 0)
  }, [
    applyTargetPosition,
    clearResumeSyncGrace,
    clearTransitionState,
    finishTransportTransition,
    getExpectedPosition,
    loadTrack,
    startPlayback,
    trackId,
  ])

  const finishTransition = useCallback(() => {
    finishTransportTransition()
    clearTransitionState()
  }, [clearTransitionState, finishTransportTransition])

  const beginTransition = useCallback(
    (message = 'Switching track...') => {
      const transitionTrackId = desiredStateRef.current.trackId ?? currentTrackIdRef.current
      transitionGuardRef.current = {
        trackId: transitionTrackId,
        expiresAt: Number.POSITIVE_INFINITY,
      }
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current)
        transitionTimerRef.current = null
      }
      beginCommandWait(message)
    },
    [beginCommandWait],
  )

  const reportDrift = useCallback(
    (args: { targetPosition: number; actualPosition: number | null; syncType: string; rttMs: number | null }) => {
      const audio = audioRef.current
      const syncType = args.syncType.toLowerCase()
      const authoritativeSync = isAuthoritativeDirectSyncType(syncType)
      const transportPhase = getTransportTransitionPhase()
      const withinOpeningGraceWindow =
        Date.now() - lastTrackLoadAtRef.current < TRACK_START_STABILIZE_MS &&
        args.targetPosition <= TRACK_OPENING_GRACE_S &&
        (args.actualPosition ?? 0) <= TRACK_OPENING_GRACE_S &&
        args.targetPosition >= (args.actualPosition ?? 0)
      const deferAuthoritativeSync =
        transportPhase !== 'idle' ||
        syncType === 'command:play' ||
        syncType === 'command:pause' ||
        syncType === 'command:seek'

      if (
        !deferAuthoritativeSync &&
        audio &&
        audio.readyState >= 1 &&
        Number.isFinite(args.targetPosition)
      ) {
        const strictSync =
          isPaused ||
          syncType === 'command:pause' ||
          (syncType === 'command:seek' && isPaused)
        if (authoritativeSync && (!withinOpeningGraceWindow || strictSync)) {
          applyTargetPosition(args.targetPosition, strictSync ? 'strict' : 'soft')
        }
      } else if (!deferAuthoritativeSync && authoritativeSync) {
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
    [applyTargetPosition, getTransportTransitionPhase, isPaused, seekToExpectedPosition],
  )

  return {
    audioRef,
    mediaDuration,
    audioConnectionState,
    audioConnectionMessage,
    audioDiagnostics,
    audioNeedsRestart,
    beginTransition,
    beginCommandWait,
    finishTransition,
    isTransportTransitionActive,
    restartAudio,
    reportDrift,
  }
}
