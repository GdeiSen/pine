'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AudioConnectionState, AudioDiagnostics } from '@/stores/station.store'
import { resolveConfiguredOrigin } from '@/lib/origin'
import type { PlaybackQualityPreference } from '@web-radio/shared'

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
const STREAM_MANIFEST_CACHE_TTL_MS = 5 * 60_000
const DIRECT_MEDIA_STRICT = process.env.NEXT_PUBLIC_DIRECT_MEDIA_STRICT !== '0'

type DirectTransportPhase = 'idle' | 'pause' | 'track-change' | 'seek'
type BrowserAudioContext = AudioContext

type UseDirectPlaybackEngineArgs = {
  trackId: string | null
  prefetchTrackId?: string | null
  trackStartedAt: number | null
  currentPosition: number
  isPaused: boolean
  trackDuration: number
  volume: number
  playbackQuality: PlaybackQualityPreference
}

type StreamManifestResponse = {
  streamUrl?: string
  selectedAssetKind?: string
  selectedQuality?: PlaybackQualityPreference
  deliveryMode?: 'DIRECT_MEDIA' | 'API_PROXY'
  availableAssets?: Array<{
    kind?: string
    quality?: PlaybackQualityPreference
    mimeType?: string
    bitrate?: number | null
    sampleRate?: number | null
    channels?: number | null
    duration?: number | null
    byteSize?: number | null
  }>
}

export type MediaDeliveryInfo = {
  selectedAssetKind: string | null
  selectedQuality: PlaybackQualityPreference | null
  selectedBitrate: number | null
  selectedMimeType: string | null
  deliveryMode: 'DIRECT_MEDIA' | 'API_PROXY' | null
}

function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('access_token')
}

function normalizePlaybackQuality(value: unknown): PlaybackQualityPreference {
  switch (String(value ?? '').toUpperCase()) {
    case 'LOW':
      return 'LOW'
    case 'MEDIUM':
      return 'MEDIUM'
    case 'HIGH':
      return 'HIGH'
    case 'ORIGINAL':
      return 'ORIGINAL'
    default:
      return 'AUTO'
  }
}

function buildStreamUrl(trackId: string, playbackQuality: PlaybackQualityPreference): string {
  const token = getAccessToken()
  const backendOrigin = resolveConfiguredOrigin(MEDIA_BASE_URL)
  const base = backendOrigin
    ? `${backendOrigin}/api/tracks/${trackId}/stream`
    : `${API_URL}/tracks/${trackId}/stream`

  const params = new URLSearchParams()
  params.set('quality', normalizePlaybackQuality(playbackQuality))
  if (token) {
    params.set('access_token', token)
  }

  return `${base}?${params.toString()}`
}

function buildManifestUrl(trackId: string, playbackQuality: PlaybackQualityPreference): string {
  const token = getAccessToken()
  const backendOrigin = resolveConfiguredOrigin(MEDIA_BASE_URL)
  const base = backendOrigin
    ? `${backendOrigin}/api/tracks/${trackId}/manifest`
    : `${API_URL}/tracks/${trackId}/manifest`

  const params = new URLSearchParams()
  params.set('quality', normalizePlaybackQuality(playbackQuality))
  if (token) {
    params.set('access_token', token)
  }
  return `${base}?${params.toString()}`
}

function withAccessToken(url: string) {
  const token = getAccessToken()
  if (!token) return url

  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.href : undefined)
    const isPresignedUrl =
      parsed.searchParams.has('X-Amz-Signature') ||
      parsed.searchParams.has('X-Amz-Credential') ||
      parsed.searchParams.has('X-Amz-Algorithm') ||
      parsed.searchParams.has('Signature')
    if (isPresignedUrl) {
      return parsed.toString()
    }
    const isApiPath = parsed.pathname.includes('/api/')
    if (!isApiPath) {
      return parsed.toString()
    }
    if (!parsed.searchParams.has('access_token')) {
      parsed.searchParams.set('access_token', token)
    }
    return parsed.toString()
  } catch {
    return url
  }
}

function resolveStreamUrlCandidate(rawUrl: string): string {
  const backendOrigin = resolveConfiguredOrigin(MEDIA_BASE_URL)
  try {
    if (backendOrigin) {
      return new URL(rawUrl, backendOrigin).toString()
    }
    if (typeof window !== 'undefined') {
      return new URL(rawUrl, window.location.origin).toString()
    }
  } catch {
    return rawUrl
  }
  return rawUrl
}

function normalizeMediaUrl(url: string): string {
  if (typeof window === 'undefined') return url
  try {
    return new URL(url, window.location.href).href
  } catch {
    return url
  }
}

function resolveManifestSelectedAsset(payload: StreamManifestResponse) {
  const assets = Array.isArray(payload.availableAssets) ? payload.availableAssets : []
  const selectedAssetKind = typeof payload.selectedAssetKind === 'string' ? payload.selectedAssetKind : null
  const byKind = selectedAssetKind
    ? assets.find((asset) => asset?.kind === selectedAssetKind)
    : null

  if (byKind) return byKind

  const selectedQuality = payload.selectedQuality ?? null
  if (!selectedQuality) return null
  return assets.find((asset) => asset?.quality === selectedQuality) ?? null
}

function buildFallbackDeliveryInfo(
  requestedQuality: PlaybackQualityPreference,
): MediaDeliveryInfo {
  return {
    selectedAssetKind: null,
    selectedQuality: requestedQuality === 'AUTO' ? null : requestedQuality,
    selectedBitrate: null,
    selectedMimeType: null,
    deliveryMode: 'API_PROXY',
  }
}

function toMediaDeliveryInfo(
  payload: StreamManifestResponse,
  requestedQuality: PlaybackQualityPreference,
): MediaDeliveryInfo {
  const selectedAsset = resolveManifestSelectedAsset(payload)

  return {
    selectedAssetKind:
      typeof payload.selectedAssetKind === 'string'
        ? payload.selectedAssetKind
        : typeof selectedAsset?.kind === 'string'
          ? selectedAsset.kind
          : null,
    selectedQuality:
      payload.selectedQuality ?? (typeof selectedAsset?.quality === 'string'
        ? normalizePlaybackQuality(selectedAsset.quality)
        : requestedQuality === 'AUTO'
          ? null
          : requestedQuality),
    selectedBitrate:
      typeof selectedAsset?.bitrate === 'number' && Number.isFinite(selectedAsset.bitrate)
        ? Math.max(1, Math.round(selectedAsset.bitrate))
        : null,
    selectedMimeType:
      typeof selectedAsset?.mimeType === 'string' && selectedAsset.mimeType.trim().length > 0
        ? selectedAsset.mimeType.trim().toLowerCase()
        : null,
    deliveryMode:
      payload.deliveryMode === 'DIRECT_MEDIA' || payload.deliveryMode === 'API_PROXY'
        ? payload.deliveryMode
        : null,
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

function getAudioContextConstructor(): {
  new (): BrowserAudioContext
} | null {
  if (typeof window === 'undefined') return null

  const ctor =
    window.AudioContext ??
    (window as typeof window & {
      webkitAudioContext?: {
        new (): BrowserAudioContext
      }
    }).webkitAudioContext

  if (typeof ctor !== 'function') return null
  return ctor as { new (): BrowserAudioContext }
}

export function useDirectPlaybackEngine({
  trackId,
  prefetchTrackId = null,
  trackStartedAt,
  currentPosition,
  isPaused,
  trackDuration,
  volume,
  playbackQuality,
}: UseDirectPlaybackEngineArgs) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const mountedRef = useRef(false)
  const currentTrackIdRef = useRef<string | null>(null)
  const sourceUrlRef = useRef<string | null>(null)
  const sourceDescriptorRef = useRef<{
    trackId: string
    quality: PlaybackQualityPreference
  } | null>(null)
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
  const audioContextRef = useRef<BrowserAudioContext | null>(null)
  const mediaSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)
  const isPausedRef = useRef(isPaused)
  const trackDurationRef = useRef(trackDuration)
  const currentPositionRef = useRef(currentPosition)
  const trackStartedAtRef = useRef(trackStartedAt)
  const playbackQualityRef = useRef<PlaybackQualityPreference>(
    normalizePlaybackQuality(playbackQuality),
  )
  const stallRecoveryTimerRef = useRef<number | null>(null)
  const stallRecoveryAttemptsRef = useRef(0)
  const sourcePlaybackStartedRef = useRef(false)
  const prefetchAudioRef = useRef<HTMLAudioElement | null>(null)
  const prefetchUrlRef = useRef<string | null>(null)
  const streamManifestCacheRef = useRef<
    Map<
      string,
      {
        streamUrl: string
        expiresAt: number
        deliveryInfo: MediaDeliveryInfo
      }
    >
  >(new Map())
  const trackLoadRequestTokenRef = useRef(0)
  const playRequestInFlightRef = useRef(false)
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
  const [mediaDeliveryInfo, setMediaDeliveryInfo] = useState<MediaDeliveryInfo | null>(null)

  const resolveManifestAwareStreamUrl = useCallback(
    async (id: string, quality: PlaybackQualityPreference) => {
      const normalizedQuality = normalizePlaybackQuality(quality)
      const cacheKey = `${id}:${normalizedQuality}`
      const now = Date.now()
      const cached = streamManifestCacheRef.current.get(cacheKey)
      if (cached && cached.expiresAt > now) {
        return {
          streamUrl: cached.streamUrl,
          deliveryInfo: cached.deliveryInfo,
        }
      }

      const fallbackUrl = normalizeMediaUrl(buildStreamUrl(id, normalizedQuality))
      const fallbackDeliveryInfo = buildFallbackDeliveryInfo(normalizedQuality)
      const strictDirect = DIRECT_MEDIA_STRICT

      try {
        const response = await fetch(buildManifestUrl(id, normalizedQuality), {
          method: 'GET',
          cache: 'no-store',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        })

        if (!response.ok) {
          if (strictDirect) {
            throw new Error(`Manifest request failed with status ${response.status}`)
          }
          return {
            streamUrl: fallbackUrl,
            deliveryInfo: fallbackDeliveryInfo,
          }
        }

        const payload = (await response.json().catch(() => null)) as StreamManifestResponse | null
        if (!payload?.streamUrl || typeof payload.streamUrl !== 'string') {
          if (strictDirect) {
            throw new Error('Manifest response does not include streamUrl')
          }
          return {
            streamUrl: fallbackUrl,
            deliveryInfo: fallbackDeliveryInfo,
          }
        }

        const resolved = normalizeMediaUrl(
          withAccessToken(resolveStreamUrlCandidate(payload.streamUrl)),
        )
        const deliveryInfo = toMediaDeliveryInfo(payload, normalizedQuality)
        if (strictDirect && deliveryInfo.deliveryMode === 'API_PROXY') {
          throw new Error('Strict direct playback is enabled, but manifest resolved API proxy mode')
        }
        streamManifestCacheRef.current.set(cacheKey, {
          streamUrl: resolved,
          expiresAt: now + STREAM_MANIFEST_CACHE_TTL_MS,
          deliveryInfo,
        })
        return {
          streamUrl: resolved,
          deliveryInfo,
        }
      } catch (error) {
        if (strictDirect) {
          throw error
        }
        return {
          streamUrl: fallbackUrl,
          deliveryInfo: fallbackDeliveryInfo,
        }
      }
    },
    [],
  )

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

  const teardownGainLayer = useCallback(() => {
    try {
      mediaSourceNodeRef.current?.disconnect()
    } catch {
      // no-op
    }
    try {
      gainNodeRef.current?.disconnect()
    } catch {
      // no-op
    }

    mediaSourceNodeRef.current = null
    gainNodeRef.current = null

    const context = audioContextRef.current
    audioContextRef.current = null
    if (context) {
      void context.close().catch(() => undefined)
    }
  }, [])

  const readOutputGain = useCallback(() => {
    const gainNode = gainNodeRef.current
    if (gainNode) return clampVolume(gainNode.gain.value)
    const audio = audioRef.current
    return clampVolume(audio?.volume ?? 1)
  }, [])

  const setOutputGain = useCallback((target: number) => {
    const clamped = clampVolume(target)
    const gainNode = gainNodeRef.current
    if (gainNode) {
      gainNode.gain.value = clamped
      return
    }

    const audio = audioRef.current
    if (audio) {
      audio.volume = clamped
    }
  }, [])

  const ensureGainLayer = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return false

    if (gainNodeRef.current && mediaSourceNodeRef.current && audioContextRef.current) {
      audio.volume = 1
      return true
    }

    const Ctor = getAudioContextConstructor()
    if (!Ctor) return false

    try {
      const context = audioContextRef.current ?? new Ctor()
      audioContextRef.current = context

      const sourceNode =
        mediaSourceNodeRef.current ?? context.createMediaElementSource(audio)
      mediaSourceNodeRef.current = sourceNode

      const gainNode = gainNodeRef.current ?? context.createGain()
      gainNodeRef.current = gainNode

      sourceNode.disconnect()
      gainNode.disconnect()
      sourceNode.connect(gainNode)
      gainNode.connect(context.destination)
      gainNode.gain.value = clampVolume(targetVolumeRef.current)
      audio.volume = 1

      return true
    } catch {
      return false
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
      if (!audioRef.current) {
        onComplete?.()
        return
      }

      const clampedTarget = clampVolume(target)
      const startVolume = readOutputGain()
      const duration = Math.max(0, durationMs)

      if (duration <= 0 || Math.abs(startVolume - clampedTarget) < 0.001) {
        setOutputGain(clampedTarget)
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
        if (!audioRef.current) return

        const t = Math.max(0, Math.min(1, (now - startedAt) / duration))
        const eased = 1 - Math.pow(1 - t, 3)
        setOutputGain(
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
    [readOutputGain, setOutputGain],
  )

  const fadeInToTargetVolume = useCallback(() => {
    if (!audioRef.current) return
    const target = targetVolumeRef.current
    if (target <= 0) {
      setOutputGain(0)
      return
    }
    fadeVolumeTo(target, VOLUME_FADE_IN_MS)
  }, [fadeVolumeTo, setOutputGain])

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

  useEffect(() => {
    playbackQualityRef.current = normalizePlaybackQuality(playbackQuality)
  }, [playbackQuality])

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
      if (playRequestInFlightRef.current) return

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

      playRequestInFlightRef.current = true
      try {
        const gainLayerReady = ensureGainLayer()
        if (gainLayerReady) {
          await audioContextRef.current?.resume().catch(() => undefined)
        }
        stopVolumeFade()
        setOutputGain(0)
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
      } finally {
        playRequestInFlightRef.current = false
      }
    },
    [
      armResumeSyncGrace,
      fadeInToTargetVolume,
      finishTransportTransition,
      setConnectionStatus,
      setNeedsRestart,
      ensureGainLayer,
      setOutputGain,
      stopVolumeFade,
    ],
  )

  const beginCommandWait = useCallback(
    (_message = 'Waiting for server confirmation...') => {
      playTokenRef.current += 1
      clearResumeSyncGrace()
      clearStallRecovery(true)
    },
    [clearResumeSyncGrace, clearStallRecovery],
  )

  const loadTrack = useCallback(
    async (id: string, targetPosition: number) => {
      const audio = audioRef.current
      if (!audio) return

      const requestToken = ++trackLoadRequestTokenRef.current
      const normalizedTarget = Number.isFinite(targetPosition) ? Math.max(0, targetPosition) : 0
      pendingTargetPositionRef.current = normalizedTarget
      lastTrackLoadAtRef.current = Date.now()
      sourcePlaybackStartedRef.current = false
      playTokenRef.current += 1
      clearTransitionState()
      clearResumeSyncGrace()
      clearStallRecovery(true)

      stopVolumeFade()
      audio.pause()

      const resolvedQuality = playbackQualityRef.current
      let resolvedSource: { streamUrl: string; deliveryInfo: MediaDeliveryInfo }
      try {
        resolvedSource = await resolveManifestAwareStreamUrl(id, resolvedQuality)
      } catch (error) {
        if (!mountedRef.current || requestToken !== trackLoadRequestTokenRef.current) {
          return
        }
        const errorMessage = error instanceof Error ? error.message : 'Failed to load media manifest'
        setConnectionStatus('reconnecting', errorMessage)
        setMediaDeliveryInfo(null)
        return
      }
      const url = normalizeMediaUrl(resolvedSource.streamUrl)

      if (!mountedRef.current || requestToken !== trackLoadRequestTokenRef.current) {
        return
      }

      const sourceChanged = sourceUrlRef.current !== url
      const desired = desiredStateRef.current
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

      if (sourceChanged) {
        setMediaDuration(null)
        sourceUrlRef.current = url
        sourceDescriptorRef.current = {
          trackId: id,
          quality: resolvedQuality,
        }
        setOutputGain(0)
        audio.src = url
        audio.preload = 'auto'
        audio.load()
      } else if (
        !sourceDescriptorRef.current ||
        sourceDescriptorRef.current.trackId !== id ||
        sourceDescriptorRef.current.quality !== resolvedQuality
      ) {
        sourceDescriptorRef.current = {
          trackId: id,
          quality: resolvedQuality,
        }
      } else if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
        audio.load()
      }

      if (desired.trackId !== id) return
      setMediaDeliveryInfo(resolvedSource.deliveryInfo)

      if (desired.isPaused) {
        setConnectionStatus('paused', null)
        return
      }

      if (sourceChanged) {
        // Start playback request immediately after assigning src.
        // Browser will begin output as soon as initial buffer is available.
        void startPlayback('Loading track...', {
          suppressConnectingPulse: true,
        })
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
      resolveManifestAwareStreamUrl,
      setOutputGain,
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
          setOutputGain(targetVolumeRef.current)
          finishTransportTransition(token)
          return
        }

        currentAudio.pause()
        if (currentAudio.readyState >= 1) {
          applyTargetPosition(normalizedTarget, 'strict')
          pendingTargetPositionRef.current = null
        }
        setOutputGain(targetVolumeRef.current)
        setConnectionStatus('paused', null)
        finishTransportTransition(token)
      }

      const token = beginTransportTransition('pause')

      if (!audio || audio.paused || audio.readyState < HTMLMediaElement.HAVE_METADATA) {
        finalizePause(token)
        return
      }

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
      setOutputGain,
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
        setOutputGain(0)
        fadeInToTargetVolume()
        setConnectionStatus('playing', null)
        finishTransportTransition(token)
      }

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
      setOutputGain,
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
    audio.volume = 1
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
      if (audio.paused && !playRequestInFlightRef.current) {
        void engineCallbacksRef.current.startPlayback('Loading track...')
      }
    }

    const onPlaying = () => {
      const desired = desiredStateRef.current
      if (!hasExpectedSource()) return
      sourcePlaybackStartedRef.current = true
      playRequestInFlightRef.current = false
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
      playRequestInFlightRef.current = false
      engineCallbacksRef.current.clearStallRecovery(true)
      alignPendingTarget('strict')
      setOutputGain(targetVolumeRef.current)
      engineCallbacksRef.current.setConnectionStatus('paused', null)
      if (transportPhase === 'pause') {
        engineCallbacksRef.current.finishTransportTransition()
      }
    }

    const onError = () => {
      const desired = desiredStateRef.current
      if (!desired.trackId) return
      playRequestInFlightRef.current = false

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
      setMediaDeliveryInfo(null)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('durationchange', updateMediaDuration)
      audio.removeEventListener('canplay', onCanPlay)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('stalled', onStalled)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('error', onError)
      audio.pause()
      playRequestInFlightRef.current = false
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
      sourceDescriptorRef.current = null
      teardownGainLayer()
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
  }, [setOutputGain, teardownGainLayer])

  // Volume
  useEffect(() => {
    targetVolumeRef.current = clampVolume(volume)
    const audio = audioRef.current
    if (!audio) return

    const target = targetVolumeRef.current
    if (audio.paused || desiredStateRef.current.isPaused) {
      stopVolumeFade()
      setOutputGain(target)
      return
    }

    setOutputGain(target)
  }, [volume, setOutputGain, stopVolumeFade])

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

    let cancelled = false
    let createdPrefetch: HTMLAudioElement | null = null

    const resolveAndPrefetch = async () => {
      const resolvedSource = await resolveManifestAwareStreamUrl(
        nextTrackId,
        playbackQualityRef.current,
      )
      const nextUrl = normalizeMediaUrl(resolvedSource.streamUrl)
      if (cancelled) return
      if (prefetchUrlRef.current === nextUrl) {
        return
      }

      const prefetchAudio = new Audio()
      createdPrefetch = prefetchAudio
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
    }

    void resolveAndPrefetch()

    return () => {
      cancelled = true
      if (!createdPrefetch || prefetchAudioRef.current !== createdPrefetch) return
      prefetchAudioRef.current = null
      prefetchUrlRef.current = null
      createdPrefetch.pause()
      createdPrefetch.removeAttribute('src')
      createdPrefetch.load()
    }
  }, [playbackQuality, prefetchTrackId, resolveManifestAwareStreamUrl, trackId])

  // Track change — reload and seek
  useEffect(() => {
    if (!trackId) {
      currentTrackIdRef.current = null
      const audio = audioRef.current
      if (audio) {
        stopVolumeFade()
        setMediaDuration(null)
        setMediaDeliveryInfo(null)
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
        sourceUrlRef.current = null
        sourceDescriptorRef.current = null
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
      const resolvedQuality = playbackQualityRef.current
      const hasMatchingSourceDescriptor =
        sourceDescriptorRef.current?.trackId === trackId &&
        sourceDescriptorRef.current?.quality === resolvedQuality
      if (!hasMatchingSourceDescriptor || !!audio.error || !audio.currentSrc) {
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
    const resolvedQuality = playbackQualityRef.current
    const hasMatchingSourceDescriptor =
      sourceDescriptorRef.current?.trackId === trackId &&
      sourceDescriptorRef.current?.quality === resolvedQuality

    if (audio && hasMatchingSourceDescriptor && audio.currentSrc) {
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
    mediaDeliveryInfo,
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
