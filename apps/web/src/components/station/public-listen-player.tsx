'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { PlaybackCommandType, PlaybackEventType, WS_EVENTS_V2 } from '@web-radio/shared'
import { ListenOnlyPlayerCard } from '@/components/station/listen-only-player-card'
import { useAudioStore } from '@/stores/audio.store'
import { useStationStore } from '@/stores/station.store'
import { fetchStationStreamInfo } from '@/lib/api'
import { getSocket } from '@/lib/socket'
import { useDirectPlaybackEngine } from '@/hooks/useDirectPlaybackEngine'
import {
  getEstimatedServerPosition,
  getServerOffsetMs,
  normalizeTrackStartedAt,
  useRadioPlaybackEngine,
} from '@/hooks/useRadioPlaybackEngine'

const DIRECT_ONLY_DEPLOYMENT =
  process.env.NEXT_PUBLIC_APP_DEPLOYMENT_MODE?.trim().toLowerCase() === 'direct'
const DEFAULT_PLAYBACK_MODE = DIRECT_ONLY_DEPLOYMENT ? 'DIRECT' : 'BROADCAST'
const DIRECT_COMMAND_WAIT_TIMEOUT_MS = 15_000

function normalizePlaybackVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null
}

function isStalePlaybackVersion(currentVersion: number, incomingVersion: number | null) {
  return incomingVersion !== null && currentVersion > 0 && incomingVersion < currentVersion
}

interface PublicListenState {
  code: string
  name: string
  listenerCount: number
  accessMode: 'PUBLIC' | 'PRIVATE'
  isPasswordProtected: boolean
  playbackMode?: 'DIRECT' | 'BROADCAST'
  currentTrackId: string | null
  currentTrack?: {
    id: string
    title: string | null
    artist: string | null
    album: string | null
    year: number | null
    genre: string | null
    duration: number
    hasCover: boolean
    quality: string
  } | null
  currentPosition?: number
  isPaused?: boolean
  trackStartedAt?: string | null
  pausedPosition?: number
  playbackVersion?: number
  serverTime?: string | null
  streamUrl?: string | null
}

export function PublicListenPlayer({ code, initialState }: { code: string; initialState: PublicListenState }) {
  const [state, setState] = useState<PublicListenState>({
    ...initialState,
    streamUrl: initialState.streamUrl ?? null,
  })
  const serverOffsetMsRef = useRef<number | null>(getServerOffsetMs(initialState.serverTime))
  const volume = useAudioStore((s) => s.volume)
  const setAudioConnection = useStationStore((s) => s.setAudioConnection)
  const socket = getSocket()
  const isDirectMode = (state.playbackMode ?? DEFAULT_PLAYBACK_MODE) === 'DIRECT'

  const broadcastPlayback = useRadioPlaybackEngine({
    streamUrl: isDirectMode ? null : state.streamUrl ?? null,
    isPlaying: !isDirectMode && !!state.currentTrackId && !state.isPaused,
    volume,
  })

  const directPlayback = useDirectPlaybackEngine({
    trackId: isDirectMode ? state.currentTrackId : null,
    trackStartedAt: isDirectMode ? normalizeTrackStartedAt(state.trackStartedAt) : null,
    currentPosition: state.currentPosition ?? 0,
    isPaused: !!state.isPaused,
    trackDuration: state.currentTrack?.duration ?? 0,
    volume,
  })

  const playback = isDirectMode ? directPlayback : broadcastPlayback
  const effectiveTrackDuration = useMemo(() => {
    const metadataDuration = state.currentTrack?.duration ?? 0
    if (!isDirectMode) return metadataDuration

    const detectedDuration = directPlayback.mediaDuration
    if (typeof detectedDuration !== 'number' || !Number.isFinite(detectedDuration) || detectedDuration <= 0) {
      return metadataDuration
    }

    return detectedDuration
  }, [directPlayback.mediaDuration, isDirectMode, state.currentTrack?.duration])
  const stateRef = useRef(state)
  const playbackRef = useRef(playback)
  const isDirectModeRef = useRef(isDirectMode)
  const pendingDirectCommandRef = useRef<{
    type: PlaybackCommandType
    trackIdBefore: string | null
    expiresAt: number
  } | null>(null)
  stateRef.current = state
  playbackRef.current = playback
  isDirectModeRef.current = isDirectMode

  const getPendingDirectCommand = () => {
    const pending = pendingDirectCommandRef.current
    if (!pending) return null
    if (Date.now() <= pending.expiresAt) return pending
    if (
      pending.type === PlaybackCommandType.SKIP ||
      pending.type === PlaybackCommandType.PREVIOUS
    ) {
      playbackRef.current.finishTransition()
    }
    pendingDirectCommandRef.current = null
    return null
  }

  const clearPendingDirectCommand = (options?: { finishTransition?: boolean }) => {
    const pending = pendingDirectCommandRef.current
    if (
      pending &&
      options?.finishTransition &&
      (pending.type === PlaybackCommandType.SKIP || pending.type === PlaybackCommandType.PREVIOUS)
    ) {
      playbackRef.current.finishTransition()
    }
    pendingDirectCommandRef.current = null
  }

  const beginDirectCommandWait = (commandType: PlaybackCommandType, trackIdBefore?: string | null) => {
    if (!isDirectModeRef.current) return
    const resolvedTrackIdBefore = trackIdBefore ?? stateRef.current.currentTrackId ?? null
    const existingPending = pendingDirectCommandRef.current
    if (
      existingPending &&
      Date.now() <= existingPending.expiresAt &&
      existingPending.type === commandType &&
      existingPending.trackIdBefore === resolvedTrackIdBefore
    ) {
      return
    }

    pendingDirectCommandRef.current = {
      type: commandType,
      trackIdBefore: resolvedTrackIdBefore,
      expiresAt: Date.now() + DIRECT_COMMAND_WAIT_TIMEOUT_MS,
    }

    switch (commandType) {
      case PlaybackCommandType.SKIP:
        playbackRef.current.beginTransition('Switching to next track...')
        break
      case PlaybackCommandType.PREVIOUS:
        playbackRef.current.beginTransition('Switching to previous track...')
        break
      case PlaybackCommandType.PLAY:
        playbackRef.current.beginCommandWait('Waiting for playback confirmation...')
        break
      case PlaybackCommandType.PAUSE:
        playbackRef.current.beginCommandWait('Waiting for pause confirmation...')
        break
      default:
        break
    }
  }

  useEffect(() => {
    setAudioConnection({
      state: playback.audioConnectionState,
      message: playback.audioConnectionMessage,
      diagnostics: playback.audioDiagnostics,
    })
  }, [
    playback.audioConnectionMessage,
    playback.audioConnectionState,
    playback.audioDiagnostics,
    setAudioConnection,
  ])

  useEffect(() => {
    if (typeof document === 'undefined') return

    const title = state.currentTrack?.title?.trim()
    const artist = state.currentTrack?.artist?.trim()
    const stationName = state.name?.trim()

    if (title) {
      document.title = artist ? `${title} — ${artist} · PINE` : `${title} · PINE`
      return
    }

    if (stationName) {
      document.title = `${stationName} · PINE`
      return
    }

    document.title = 'PINE'
  }, [state.currentTrack?.artist, state.currentTrack?.id, state.currentTrack?.title, state.name])

  useEffect(() => {
    return () => {
      if (typeof document !== 'undefined') {
        document.title = 'PINE'
      }
      setAudioConnection({ state: 'idle', message: null, diagnostics: null })
    }
  }, [setAudioConnection])

  // Tick position forward locally
  useEffect(() => {
    const timer = window.setInterval(() => {
      setState((prev) => {
        if (!prev.currentTrackId || !prev.currentTrack) return prev
        const pendingDirectCommand = pendingDirectCommandRef.current
        if (pendingDirectCommand && Date.now() > pendingDirectCommand.expiresAt) {
          if (
            pendingDirectCommand.type === PlaybackCommandType.SKIP ||
            pendingDirectCommand.type === PlaybackCommandType.PREVIOUS
          ) {
            playbackRef.current.finishTransition()
          }
          pendingDirectCommandRef.current = null
        }
        const pendingDirectActive =
          !!pendingDirectCommandRef.current && Date.now() <= pendingDirectCommandRef.current.expiresAt

        if (isDirectModeRef.current) {
          if (pendingDirectActive) {
            return prev
          }
          const directAudio = playbackRef.current.audioRef.current
          if (
            prev.isPaused ||
            !directAudio ||
            directAudio.paused ||
            directAudio.readyState < 1
          ) {
            return prev
          }

          const currentPosition = Math.min(
            prev.currentTrack.duration > 0 ? prev.currentTrack.duration : Number.POSITIVE_INFINITY,
            Math.max(0, directAudio.currentTime),
          )

          if (Math.abs((prev.currentPosition ?? 0) - currentPosition) < 0.05) {
            return prev
          }

          return {
            ...prev,
            currentPosition,
          }
        }

        const currentPosition = getEstimatedServerPosition({
          currentPosition: prev.currentPosition ?? 0,
          duration: prev.currentTrack?.duration ?? 0,
          isPaused: !!prev.isPaused,
          pausedPosition: prev.pausedPosition,
          serverOffsetMs: serverOffsetMsRef.current,
          trackStartedAt: normalizeTrackStartedAt(prev.trackStartedAt),
        })

        if (Math.abs((prev.currentPosition ?? 0) - currentPosition) < 0.05) {
          return prev
        }

        return {
          ...prev,
          currentPosition,
        }
      })
    }, 250)
    return () => window.clearInterval(timer)
  }, [])

  // WebSocket connection
  useEffect(() => {
    let cancelled = false

    const refreshStreamUrl = async () => {
      if (DIRECT_ONLY_DEPLOYMENT) return
      if (isDirectModeRef.current) return
      const info = await fetchStationStreamInfo(code).catch(() => null)
      if (cancelled) return
      if (info?.playbackMode === 'DIRECT') {
        setState((prev) => ({ ...prev, streamUrl: null, playbackMode: 'DIRECT' }))
        return
      }
      if (cancelled || !info?.streamUrl) return
      setState((prev) => ({ ...prev, streamUrl: info.streamUrl }))
    }

    const handleStationState = (data: any) => {
      if (cancelled) return
      const currentVersion = stateRef.current.playbackVersion ?? 0
      const incomingVersion = normalizePlaybackVersion(data.version)
      if (isStalePlaybackVersion(currentVersion, incomingVersion)) {
        return
      }
      const startedAt = normalizeTrackStartedAt(data.trackStartedAt)
      const offsetMs = getServerOffsetMs(data.station?.serverTime ?? data.serverTime, Date.now())
      if (offsetMs !== null) serverOffsetMsRef.current = offsetMs
      const nextPlaybackMode = data.station?.playbackMode ?? stateRef.current.playbackMode ?? DEFAULT_PLAYBACK_MODE
      const nextIsDirectMode = nextPlaybackMode === 'DIRECT'

      const targetPosition = getEstimatedServerPosition({
        currentPosition: data.currentPosition ?? 0,
        duration: data.currentTrack?.duration ?? 0,
        isPaused: !!data.isPaused,
        pausedPosition: 0,
        serverOffsetMs: serverOffsetMsRef.current,
        trackStartedAt: startedAt,
      })
      const directAudio = nextIsDirectMode ? playbackRef.current.audioRef.current : null
      const directActualPosition =
        directAudio && Number.isFinite(directAudio.currentTime) ? Math.max(0, directAudio.currentTime) : null
      const position =
        nextIsDirectMode &&
        !data.isPaused &&
        directActualPosition !== null &&
        playbackRef.current.audioConnectionState === 'playing'
          ? Math.max(targetPosition, directActualPosition)
          : targetPosition

      setState((prev) => ({
        ...prev,
        name: data.station?.name ?? prev.name,
        listenerCount: data.station?.listenerCount ?? prev.listenerCount,
        playbackMode: nextPlaybackMode,
        ...(incomingVersion !== null ? { playbackVersion: incomingVersion } : {}),
        currentTrackId: data.currentTrack?.id ?? null,
        currentTrack: data.currentTrack ?? null,
        currentPosition: position,
        isPaused: data.isPaused ?? false,
        trackStartedAt: data.trackStartedAt ?? null,
      }))

      const pendingDirectCommand = getPendingDirectCommand()
      if (nextIsDirectMode && pendingDirectCommand) {
        const nextTrackId = data.currentTrack?.id ?? null
        const resolvedTrackChange =
          (pendingDirectCommand.type === PlaybackCommandType.SKIP ||
            pendingDirectCommand.type === PlaybackCommandType.PREVIOUS) &&
          nextTrackId !== pendingDirectCommand.trackIdBefore
        const resolvedPlayPause =
          (pendingDirectCommand.type === PlaybackCommandType.PLAY && !(data.isPaused ?? false)) ||
          (pendingDirectCommand.type === PlaybackCommandType.PAUSE && !!data.isPaused)
        if (resolvedTrackChange || resolvedPlayPause) {
          clearPendingDirectCommand({ finishTransition: resolvedTrackChange })
        }
      }
    }
    socket.on(WS_EVENTS_V2.STATION_STATE, handleStationState)

    const handleTrackChanged = (data: any) => {
      if (cancelled) return
      const currentVersion = stateRef.current.playbackVersion ?? 0
      const incomingVersion = normalizePlaybackVersion(data.version)
      if (isStalePlaybackVersion(currentVersion, incomingVersion)) {
        return
      }
      const startedAt = normalizeTrackStartedAt(data.trackStartedAt)
      const nextPlaybackMode = stateRef.current.playbackMode ?? DEFAULT_PLAYBACK_MODE
      const nextIsDirectMode = nextPlaybackMode === 'DIRECT'
      const previousTrackId = stateRef.current.currentTrackId ?? null
      const nextTrackId = data.track?.id ?? null
      const commandType = typeof data.commandType === 'string' ? data.commandType : null
      const pendingDirectCommand = getPendingDirectCommand()
      if (
        nextIsDirectMode &&
        previousTrackId &&
        nextTrackId &&
        nextTrackId !== previousTrackId &&
        !pendingDirectCommand
      ) {
        playbackRef.current.beginCommandWait('Loading next track...')
      }
      const targetPosition = getEstimatedServerPosition({
        currentPosition: 0,
        duration: data.track?.duration ?? 0,
        isPaused: !!data.isPaused,
        pausedPosition: 0,
        serverOffsetMs: serverOffsetMsRef.current,
        trackStartedAt: startedAt,
      })
      const directAudio = nextIsDirectMode ? playbackRef.current.audioRef.current : null
      const directActualPosition =
        directAudio && Number.isFinite(directAudio.currentTime) ? Math.max(0, directAudio.currentTime) : null
      const position =
        nextIsDirectMode &&
        !data.isPaused &&
        directActualPosition !== null &&
        playbackRef.current.audioConnectionState === 'playing'
          ? Math.max(targetPosition, directActualPosition)
          : targetPosition

      setState((prev) => ({
        ...prev,
        ...(incomingVersion !== null ? { playbackVersion: incomingVersion } : {}),
        currentTrackId: data.track?.id ?? null,
        currentTrack: data.track ?? null,
        currentPosition: position,
        isPaused: data.isPaused ?? false,
        trackStartedAt: data.trackStartedAt ?? null,
      }))

      if (nextIsDirectMode && pendingDirectCommand) {
        const resolvedTrackChange =
          (pendingDirectCommand.type === PlaybackCommandType.SKIP ||
            pendingDirectCommand.type === PlaybackCommandType.PREVIOUS) &&
          (commandType === pendingDirectCommand.type ||
            nextTrackId !== pendingDirectCommand.trackIdBefore)

        if (resolvedTrackChange) {
          const sameTrackTransition =
            !!nextTrackId && nextTrackId === pendingDirectCommand.trackIdBefore
          clearPendingDirectCommand({ finishTransition: true })
          if (sameTrackTransition) {
            void playbackRef.current.restartAudio()
          }
        }
      }

      if (!nextIsDirectMode && data.track?.id) {
        void playbackRef.current.restartAudio()
      } else if (nextIsDirectMode && nextTrackId && nextTrackId !== previousTrackId) {
        clearPendingDirectCommand()
      }
    }
    socket.on(WS_EVENTS_V2.TRACK_CHANGED, handleTrackChanged)

    const handlePlaybackSync = (data: any) => {
      if (cancelled) return
      const currentState = stateRef.current
      const incomingVersion = normalizePlaybackVersion(data.version)
      if (isStalePlaybackVersion(currentState.playbackVersion ?? 0, incomingVersion)) {
        return
      }
      const commandType = typeof data.commandType === 'string' ? data.commandType : null
      const syncEventType = typeof data.type === 'string' ? data.type : null
      const nextIsDirectMode = (currentState.playbackMode ?? DEFAULT_PLAYBACK_MODE) === 'DIRECT'

      if (
        nextIsDirectMode &&
        syncEventType === PlaybackEventType.COMMAND_RECEIVED &&
        commandType &&
        (commandType === PlaybackCommandType.SKIP ||
          commandType === PlaybackCommandType.PREVIOUS)
      ) {
        beginDirectCommandWait(commandType, currentState.currentTrackId ?? null)
        return
      }

      const pendingDirectCommand = getPendingDirectCommand()
      const hasAuthoritativeTrackId =
        typeof data.currentTrackId === 'string' || data.currentTrackId === null
      const syncTrackId = hasAuthoritativeTrackId ? data.currentTrackId : currentState.currentTrackId ?? null
      if (
        nextIsDirectMode &&
        pendingDirectCommand &&
        (pendingDirectCommand.type === PlaybackCommandType.SKIP ||
          pendingDirectCommand.type === PlaybackCommandType.PREVIOUS) &&
        syncTrackId === pendingDirectCommand.trackIdBefore
      ) {
        return
      }

      const startedAt = normalizeTrackStartedAt(data.trackStartedAt) ?? normalizeTrackStartedAt(currentState.trackStartedAt)
      const nextIsPaused = data.isPaused ?? currentState.isPaused ?? false
      const currentDuration =
        typeof data.currentTrackDuration === 'number' && Number.isFinite(data.currentTrackDuration)
          ? Math.max(0, data.currentTrackDuration)
          : currentState.currentTrack?.duration ?? 0
      const reportedPosition =
        typeof data.position === 'number' && Number.isFinite(data.position)
          ? Math.max(0, data.position)
          : typeof data.currentPosition === 'number' && Number.isFinite(data.currentPosition)
            ? Math.max(0, data.currentPosition)
            : currentState.currentPosition ?? 0
      const targetPosition = getEstimatedServerPosition({
        currentPosition: reportedPosition,
        duration: currentDuration,
        isPaused: nextIsPaused,
        pausedPosition: reportedPosition,
        serverOffsetMs: serverOffsetMsRef.current,
        trackStartedAt: startedAt,
      })
      const directAudio = nextIsDirectMode ? playbackRef.current.audioRef.current : null
      const directActualPosition =
        directAudio && Number.isFinite(directAudio.currentTime) ? Math.max(0, directAudio.currentTime) : null
      const requiresAuthoritativeDirectSync =
        nextIsDirectMode &&
        (nextIsPaused ||
          playbackRef.current.audioConnectionState !== 'playing' ||
          commandType === PlaybackCommandType.PLAY ||
          commandType === PlaybackCommandType.PAUSE ||
          commandType === PlaybackCommandType.SEEK)
      const position =
        nextIsDirectMode &&
        !requiresAuthoritativeDirectSync &&
        directActualPosition !== null
          ? directActualPosition
          : targetPosition
      const nextTrackStartedAt =
        nextIsDirectMode && !requiresAuthoritativeDirectSync && !nextIsPaused
          ? currentState.trackStartedAt ?? null
          : data.trackStartedAt ?? currentState.trackStartedAt ?? null

      setState((prev) => ({
        ...prev,
        ...(incomingVersion !== null ? { playbackVersion: incomingVersion } : {}),
        currentPosition: position,
        isPaused: nextIsPaused,
        trackStartedAt: nextTrackStartedAt,
      }))

      const resolvedPendingDirectCommand = getPendingDirectCommand()
      if (nextIsDirectMode && resolvedPendingDirectCommand) {
        const resolvedTrackChange =
          (resolvedPendingDirectCommand.type === PlaybackCommandType.SKIP ||
            resolvedPendingDirectCommand.type === PlaybackCommandType.PREVIOUS) &&
          syncTrackId !== resolvedPendingDirectCommand.trackIdBefore
        const resolvedPlayPause =
          (resolvedPendingDirectCommand.type === PlaybackCommandType.PLAY && !nextIsPaused) ||
          (resolvedPendingDirectCommand.type === PlaybackCommandType.PAUSE && nextIsPaused)

        if (resolvedTrackChange) {
          clearPendingDirectCommand({ finishTransition: true })
        } else if (resolvedPlayPause) {
          clearPendingDirectCommand()
        }
      }

      if (!nextIsDirectMode || requiresAuthoritativeDirectSync) {
        playbackRef.current.reportDrift({
          targetPosition: position,
          actualPosition: directActualPosition ?? playbackRef.current.audioRef.current?.currentTime ?? null,
          syncType: commandType ? `command:${commandType.toLowerCase()}` : 'ws-sync',
          rttMs: null,
        })
      }
    }
    socket.on(WS_EVENTS_V2.PLAYBACK_SYNC, handlePlaybackSync)

    const handleListenerJoined = (data: any) => {
      if (cancelled || typeof data?.listenerCount !== 'number') return
      setState((prev) => ({ ...prev, listenerCount: data.listenerCount }))
    }
    socket.on(WS_EVENTS_V2.LISTENER_JOINED, handleListenerJoined)

    const handleListenerLeft = (data: any) => {
      if (cancelled || typeof data?.listenerCount !== 'number') return
      setState((prev) => ({ ...prev, listenerCount: data.listenerCount }))
    }
    socket.on(WS_EVENTS_V2.LISTENER_LEFT, handleListenerLeft)

    socket.connect()
    socket.emit(WS_EVENTS_V2.STATION_JOIN, { code })

    void refreshStreamUrl()

    const heartbeat = window.setInterval(() => {
      socket.emit(WS_EVENTS_V2.HEARTBEAT)
    }, 30_000)

    return () => {
      cancelled = true
      pendingDirectCommandRef.current = null
      socket.emit(WS_EVENTS_V2.STATION_LEAVE)
      socket.off(WS_EVENTS_V2.STATION_STATE, handleStationState)
      socket.off(WS_EVENTS_V2.TRACK_CHANGED, handleTrackChanged)
      socket.off(WS_EVENTS_V2.PLAYBACK_SYNC, handlePlaybackSync)
      socket.off(WS_EVENTS_V2.LISTENER_JOINED, handleListenerJoined)
      socket.off(WS_EVENTS_V2.LISTENER_LEFT, handleListenerLeft)
      socket.disconnect()
      window.clearInterval(heartbeat)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  if (!state.currentTrackId || !state.currentTrack) {
    return (
      <div className="mt-2 w-full">
        <div
          className="h-[320px] lg:h-[425px] flex items-center justify-center px-6"
          style={{
            borderRadius: 16,
            overflow: 'hidden',
            background: 'var(--bg-elevated)',
          }}
        >
          <p className="text-xs text-[--text-muted] text-center">Nothing is playing right now.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full">
      <ListenOnlyPlayerCard
        track={state.currentTrack}
        currentPosition={state.currentPosition ?? 0}
        displayDuration={effectiveTrackDuration}
        isPaused={!!state.isPaused}
        isPlaying={!state.isPaused}
        listenerCount={state.listenerCount ?? 0}
        stationName={state.name}
        stationCode={state.code}
        audioNeedsRestart={playback.audioNeedsRestart}
        audioConnectionState={playback.audioConnectionState}
        audioConnectionMessage={playback.audioConnectionMessage}
        audioDiagnostics={playback.audioDiagnostics}
        onRestartAudio={playback.restartAudio}
      />
    </div>
  )
}
