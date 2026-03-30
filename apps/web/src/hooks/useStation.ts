'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { PlaybackCommandType, WS_EVENTS_V2 } from '@web-radio/shared'
import { getSocket } from '@/lib/socket'
import api, { fetchStationStreamInfo } from '@/lib/api'
import { useStationStore } from '@/stores/station.store'
import { useAudioStore } from '@/stores/audio.store'
import {
  getEstimatedServerPosition,
  normalizeTrackStartedAt,
  useRadioPlaybackEngine,
} from './useRadioPlaybackEngine'
import { useDirectPlaybackEngine } from './useDirectPlaybackEngine'

const TIME_SYNC_INTERVAL_MS = 15_000
const TIME_SYNC_EMA_ALPHA = 0.2
const DIRECT_FORWARD_SYNC_CORRECTION_THRESHOLD_S = 1.1
const PLAY_PAUSE_INTENT_GRACE_MS = 2_200
const SEEK_INTENT_GRACE_MS = 2_500

function normalizeLoopMode(value: unknown): 'none' | 'track' | 'queue' {
  if (value === 'track' || value === 'TRACK') return 'track'
  if (value === 'queue' || value === 'QUEUE') return 'queue'
  return 'none'
}

export function useStation(code: string, joinPassword?: string | null) {
  const store = useStationStore()
  const {
    setStation,
    setStationStreamUrl,
    setPlayback,
    setQueue,
    setMembers,
    addChatMessage,
    setConnecting,
    setConnected,
    setAudioConnection,
    reset,
  } = store
  const volume = useAudioStore((s) => s.volume)
  const socket = getSocket()
  const serverOffsetRef = useRef<number | null>(null)
  const bestServerOffsetRef = useRef<{ offsetMs: number; rttMs: number } | null>(null)
  const localTickAnchorRef = useRef<number | null>(null)
  const pendingTrackSyncRef = useRef<{ trackId: string; sinceMs: number } | null>(null)
  const playPauseIntentRef = useRef<{
    action: 'play' | 'pause'
    trackId: string | null
    expiresAt: number
  } | null>(null)
  const seekIntentRef = useRef<{
    trackId: string | null
    targetPosition: number
    expiresAt: number
  } | null>(null)

  const playbackMode = store.station?.playbackMode ?? 'BROADCAST'
  const isDirectMode = playbackMode === 'DIRECT'

  const broadcastEngine = useRadioPlaybackEngine({
    streamUrl: isDirectMode ? null : store.stationStreamUrl,
    isPlaying: !isDirectMode && !!store.playback.currentTrack && !store.playback.isPaused,
    volume,
  })

  const directEngine = useDirectPlaybackEngine({
    trackId: isDirectMode ? (store.playback.currentTrack?.id ?? null) : null,
    trackStartedAt: isDirectMode ? store.playback.trackStartedAt : null,
    currentPosition: store.playback.currentPosition,
    isPaused: store.playback.isPaused,
    trackDuration: store.playback.currentTrack?.duration ?? 0,
    volume,
  })

  const audio = isDirectMode ? directEngine : broadcastEngine
  const activeAudioRef = useRef(audio)
  activeAudioRef.current = audio
  const effectiveTrackDuration = useMemo(() => {
    const metadataDuration = store.playback.currentTrack?.duration ?? 0
    if (!isDirectMode) return metadataDuration

    const detectedDuration = directEngine.mediaDuration
    if (typeof detectedDuration !== 'number' || !Number.isFinite(detectedDuration) || detectedDuration <= 0) {
      return metadataDuration
    }

    return detectedDuration
  }, [directEngine.mediaDuration, isDirectMode, store.playback.currentTrack?.duration])

  useEffect(() => {
    setAudioConnection({
      state: audio.audioConnectionState,
      message: audio.audioConnectionMessage,
      diagnostics: audio.audioDiagnostics,
    })
  }, [
    audio.audioConnectionMessage,
    audio.audioConnectionState,
    audio.audioDiagnostics,
    setAudioConnection,
  ])

  useEffect(() => {
    if (typeof document === 'undefined') return

    const title = store.playback.currentTrack?.title?.trim()
    const artist = store.playback.currentTrack?.artist?.trim()
    const stationName = store.station?.name?.trim()

    if (title) {
      document.title = artist ? `${title} — ${artist} · PINE` : `${title} · PINE`
      return
    }

    if (stationName) {
      document.title = `${stationName} · PINE`
      return
    }

    document.title = 'PINE'
  }, [store.playback.currentTrack?.artist, store.playback.currentTrack?.id, store.playback.currentTrack?.title, store.station?.name])

  useEffect(() => {
    return () => {
      if (typeof document !== 'undefined') {
        document.title = 'PINE'
      }
    }
  }, [])

  const registerTimeSyncSample = useCallback((clientTs: number, serverTs: number) => {
    const receivedTs = Date.now()
    const rttMs = Math.max(0, receivedTs - clientTs)
    const offsetMs = serverTs - (clientTs + rttMs / 2)

    const best = bestServerOffsetRef.current
    if (!best || rttMs < best.rttMs) {
      bestServerOffsetRef.current = { offsetMs, rttMs }
    }

    if (serverOffsetRef.current == null) {
      serverOffsetRef.current = offsetMs
      return
    }

    const nextOffset = serverOffsetRef.current + (offsetMs - serverOffsetRef.current) * TIME_SYNC_EMA_ALPHA
    const bestOffset = bestServerOffsetRef.current?.offsetMs

    if (typeof bestOffset === 'number' && Math.abs(bestOffset - nextOffset) > 250) {
      serverOffsetRef.current = bestOffset
      return
    }

    serverOffsetRef.current = nextOffset
  }, [])

  useEffect(() => {
    if (!code) {
      setConnecting(false)
      return
    }

    let cancelled = false

    const refreshStreamInfo = async () => {
      const info = await fetchStationStreamInfo(code, true)
      if (cancelled) return
      if (info?.streamUrl) {
        setStationStreamUrl(info.streamUrl)
      }
    }

    const refreshStationSnapshot = async () => {
      try {
        const res = await api.get(`/stations/${code}`)
        if (cancelled) return

        const snapshot = res.data as {
          currentTrack?: unknown
          currentQueueType?: 'USER' | 'SYSTEM' | null
          currentPosition?: number
          isPaused?: boolean
          trackStartedAt?: string | number | null
          station?: unknown
        }

        const station = snapshot.station ?? snapshot
        setStation(station as any)
        setPlayback({
          currentTrack: snapshot.currentTrack as any ?? null,
          currentQueueType: snapshot.currentQueueType ?? null,
          trackStartedAt: normalizeTrackStartedAt(snapshot.trackStartedAt),
          currentPosition:
            typeof snapshot.currentPosition === 'number' && Number.isFinite(snapshot.currentPosition)
              ? Math.max(0, snapshot.currentPosition)
              : 0,
          isPaused: snapshot.isPaused ?? false,
          isPlaying: !!snapshot.currentTrack && !snapshot.isPaused,
        })
      } catch {
        // best-effort state refresh
      }
    }

    setConnecting(true)
    setStationStreamUrl(null)
    void refreshStreamInfo()
    socket.connect()

    socket.emit(WS_EVENTS_V2.STATION_JOIN, {
      code,
      ...(joinPassword ? { password: joinPassword } : {}),
    })

    const requestTimeSync = () => {
      const clientTs = Date.now()
      socket.emit(WS_EVENTS_V2.TIME_SYNC, { clientTs }, (ack?: { clientTs?: number; serverTs?: number }) => {
        if (!ack || ack.clientTs !== clientTs || typeof ack.serverTs !== 'number') return
        registerTimeSyncSample(clientTs, ack.serverTs)
      })
    }

    const handleStationState = (state: any) => {
      const startedAt = normalizeTrackStartedAt(state.trackStartedAt)
      const nextTrackId = state.currentTrack?.id ?? null
      const nextPosition = getEstimatedServerPosition({
        currentPosition:
          typeof state.currentPosition === 'number' && Number.isFinite(state.currentPosition)
            ? Math.max(0, state.currentPosition)
            : 0,
        duration: state.currentTrack?.duration ?? 0,
        isPaused: state.isPaused ?? false,
        pausedPosition:
          typeof state.currentPosition === 'number' && Number.isFinite(state.currentPosition)
            ? Math.max(0, state.currentPosition)
            : 0,
        serverOffsetMs: serverOffsetRef.current,
        trackStartedAt: startedAt,
      })
      setStation(state.station)
      setQueue(state.queue ?? [])
      setMembers(state.members ?? [])
      setPlayback({
        currentTrack: state.currentTrack ?? null,
        currentQueueType: state.currentQueueType ?? null,
        isPaused: state.isPaused ?? false,
        trackStartedAt: startedAt,
        currentPosition: nextPosition,
        isPlaying: !!state.currentTrack && !state.isPaused,
      })
      if (!nextTrackId) {
        pendingTrackSyncRef.current = null
        playPauseIntentRef.current = null
        seekIntentRef.current = null
      }
      localTickAnchorRef.current = Date.now()

      setConnecting(false)
      setConnected(true)
      if (!useStationStore.getState().stationStreamUrl) {
        void refreshStreamInfo()
      }
    }
    socket.on(WS_EVENTS_V2.STATION_STATE, handleStationState)

    const handleTrackChanged = (data: any) => {
      const activeAudio = activeAudioRef.current
      const previousTrackId = useStationStore.getState().playback.currentTrack?.id ?? null
      const nextTrack = data.track ?? null
      const startedAt = normalizeTrackStartedAt(data.trackStartedAt)
      const nextPosition = getEstimatedServerPosition({
        currentPosition:
          typeof data.currentPosition === 'number' && Number.isFinite(data.currentPosition)
            ? Math.max(0, data.currentPosition)
            : 0,
        duration: nextTrack?.duration ?? 0,
        isPaused: data.isPaused ?? false,
        pausedPosition:
          typeof data.currentPosition === 'number' && Number.isFinite(data.currentPosition)
            ? Math.max(0, data.currentPosition)
            : 0,
        serverOffsetMs: serverOffsetRef.current,
        trackStartedAt: startedAt,
      })

      setPlayback({
        currentTrack: nextTrack,
        currentQueueType: data.currentQueueType ?? null,
        trackStartedAt: startedAt,
        isPaused: data.isPaused ?? false,
        currentPosition: nextPosition,
        isPlaying: !!nextTrack && !data.isPaused,
      })
      localTickAnchorRef.current = Date.now()
      const nextTrackId = nextTrack?.id ?? null
      if (nextTrackId && nextTrackId !== previousTrackId) {
        playPauseIntentRef.current = null
        seekIntentRef.current = null
        pendingTrackSyncRef.current = { trackId: nextTrackId, sinceMs: Date.now() }
        // BROADCAST mode needs an explicit audio restart; DIRECT mode reloads via trackId change
        if (useStationStore.getState().station?.playbackMode !== 'DIRECT') {
          void activeAudio.restartAudio()
        }
      } else if (!nextTrackId) {
        pendingTrackSyncRef.current = null
        playPauseIntentRef.current = null
        seekIntentRef.current = null
      }

      if (data.queue) setQueue(data.queue)
      if (!nextTrack && data.currentTrackId) {
        void refreshStationSnapshot()
      }
    }
    socket.on(WS_EVENTS_V2.TRACK_CHANGED, handleTrackChanged)

    const handlePlaybackSync = (data: any) => {
      const activeAudio = activeAudioRef.current
      const state = useStationStore.getState()
      const stationPlaybackMode = state.station?.playbackMode
      const playbackState = state.playback
      const currentTrackId = playbackState.currentTrack?.id
      if (data.currentTrackId && data.currentTrackId !== currentTrackId) {
        void refreshStationSnapshot()
        return
      }
      const syncTrackId = typeof data.currentTrackId === 'string' ? data.currentTrackId : null
      const pending = pendingTrackSyncRef.current
      const pendingActive =
        !!pending &&
        pending.trackId === syncTrackId &&
        useStationStore.getState().audioConnectionState !== 'playing'
      if (pending && !pendingActive) {
        pendingTrackSyncRef.current = null
      }
      const freezePositionWhileReconnecting =
        pendingActive
      const nextIsPaused =
        typeof data.isPaused === 'boolean' ? data.isPaused : playbackState.isPaused
      const nextTrackStartedAt =
        normalizeTrackStartedAt(data.trackStartedAt) ?? playbackState.trackStartedAt
      const commandType =
        typeof data.commandType === 'string' ? data.commandType : null
      const intent = playPauseIntentRef.current
      const intentActive =
        !!intent &&
        Date.now() <= intent.expiresAt &&
        (!intent.trackId || !syncTrackId || intent.trackId === syncTrackId)
      const seekIntent = seekIntentRef.current
      const seekIntentActive =
        !!seekIntent &&
        Date.now() <= seekIntent.expiresAt &&
        (!seekIntent.trackId || !syncTrackId || seekIntent.trackId === syncTrackId)
      let clearIntentAfterSync = false
      let clearSeekIntentAfterSync = false

      let resolvedIsPaused = nextIsPaused

      if (intentActive && intent) {
        const commandMatchesIntent =
          (intent.action === 'play' && commandType === PlaybackCommandType.PLAY) ||
          (intent.action === 'pause' && commandType === PlaybackCommandType.PAUSE)

        if (commandMatchesIntent) {
          clearIntentAfterSync = true
        } else if (intent.action === 'play' && nextIsPaused) {
          const directAudio = stationPlaybackMode === 'DIRECT' ? activeAudio.audioRef.current : null
          const directAudioPlaying =
            !!directAudio &&
            !directAudio.paused &&
            directAudio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
          const localPlaybackWantsPlay = !playbackState.isPaused
          if (directAudioPlaying || localPlaybackWantsPlay) {
            resolvedIsPaused = false
          }
        } else if (intent.action === 'pause' && !nextIsPaused) {
          const localPlaybackIsPaused = playbackState.isPaused
          if (localPlaybackIsPaused) {
            resolvedIsPaused = true
          }
        }
      } else if (intent && Date.now() > intent.expiresAt) {
        playPauseIntentRef.current = null
      }
      const pauseIntentActive = intentActive && intent?.action === 'pause'
      if (seekIntent && !seekIntentActive) {
        seekIntentRef.current = null
      }
      const currentTrackDuration =
        typeof data.currentTrackDuration === 'number' && Number.isFinite(data.currentTrackDuration)
          ? Math.max(0, data.currentTrackDuration)
          : useStationStore.getState().playback.currentTrack?.duration ?? 0
      const reportedPosition =
        typeof data.position === 'number' && Number.isFinite(data.position)
          ? Math.max(0, data.position)
          : typeof data.currentPosition === 'number' && Number.isFinite(data.currentPosition)
            ? Math.max(0, data.currentPosition)
            : playbackState.currentPosition
      const targetPosition =
        freezePositionWhileReconnecting
          ? playbackState.currentPosition
          : getEstimatedServerPosition({
              currentPosition: reportedPosition,
              duration: currentTrackDuration,
              isPaused: resolvedIsPaused,
              pausedPosition: reportedPosition,
              serverOffsetMs: serverOffsetRef.current,
              trackStartedAt: nextTrackStartedAt,
            })
      const directAudio = stationPlaybackMode === 'DIRECT' ? activeAudio.audioRef.current : null
      const directActualPosition =
        directAudio && Number.isFinite(directAudio.currentTime) ? Math.max(0, directAudio.currentTime) : null
      const useActualDirectClock =
        stationPlaybackMode === 'DIRECT' &&
        !resolvedIsPaused &&
        !freezePositionWhileReconnecting &&
        commandType !== PlaybackCommandType.SEEK &&
        directActualPosition !== null &&
        activeAudio.audioConnectionState === 'playing'
      const directForwardDriftSeconds =
        useActualDirectClock && directActualPosition !== null ? targetPosition - directActualPosition : 0
      const shouldForceForwardSync =
        useActualDirectClock &&
        commandType !== PlaybackCommandType.PLAY &&
        directForwardDriftSeconds > DIRECT_FORWARD_SYNC_CORRECTION_THRESHOLD_S
      let resolvedPosition = useActualDirectClock
        ? shouldForceForwardSync
          ? targetPosition
          : directActualPosition
        : targetPosition

      if (stationPlaybackMode === 'DIRECT') {
        const directAnchorPosition =
          directActualPosition ??
          (typeof playbackState.currentPosition === 'number' && Number.isFinite(playbackState.currentPosition)
            ? Math.max(0, playbackState.currentPosition)
            : null)

        if (
          !freezePositionWhileReconnecting &&
          directAnchorPosition !== null &&
          commandType !== PlaybackCommandType.SEEK &&
          !resolvedIsPaused &&
          !pauseIntentActive
        ) {
          // In DIRECT mode keep UI position locked to local media clock to avoid visible jumps
          // from late/out-of-order websocket sync samples.
          resolvedPosition = directAnchorPosition
        }

        if (
          commandType === PlaybackCommandType.SEEK &&
          seekIntentActive &&
          seekIntent &&
          directAnchorPosition !== null
        ) {
          // Local seek already moved audio clock optimistically; do not snap backward
          // on seek ack if server sample is slightly behind.
          resolvedPosition = resolvedIsPaused
            ? directAnchorPosition
            : Math.max(directAnchorPosition, seekIntent.targetPosition)
          clearSeekIntentAfterSync = true
        }

        if (currentTrackDuration > 0) {
          resolvedPosition = Math.min(Math.max(0, resolvedPosition), currentTrackDuration)
        }
      }
      const syncType =
        commandType
          ? `command:${commandType.toLowerCase()}`
          : typeof data.syncType === 'string'
            ? data.syncType
            : typeof data.sourceType === 'string'
              ? data.sourceType
              : 'ws-sync'

      setPlayback({
        currentPosition: resolvedPosition,
        isPaused: resolvedIsPaused,
        trackStartedAt: nextTrackStartedAt,
        ...(data.currentQueueType !== undefined && { currentQueueType: data.currentQueueType }),
        ...(data.loopMode !== undefined && { loopMode: normalizeLoopMode(data.loopMode) }),
        ...(data.shuffleEnabled !== undefined && { shuffleEnabled: data.shuffleEnabled }),
      })
      localTickAnchorRef.current = Date.now()
      if (Array.isArray(data?.queue)) {
        setQueue(data.queue)
      }
      if (clearIntentAfterSync) {
        playPauseIntentRef.current = null
      }
      if (clearSeekIntentAfterSync) {
        seekIntentRef.current = null
      }

      activeAudio.reportDrift({
        targetPosition: resolvedPosition,
        actualPosition: directActualPosition ?? activeAudio.audioRef.current?.currentTime ?? null,
        syncType,
        rttMs: typeof data.rttMs === 'number' ? data.rttMs : null,
      })

    }
    socket.on(WS_EVENTS_V2.PLAYBACK_SYNC, handlePlaybackSync)

    const handleQueueUpdated = (data: any) => {
      if (Array.isArray(data?.queue)) {
        setQueue(data.queue)
        return
      }

      const stationId = useStationStore.getState().station?.id
      if (!stationId) return
      api
        .get(`/stations/${stationId}/queue/snapshot`)
        .then((res) => {
          if (Array.isArray(res.data)) {
            setQueue(res.data)
          }
        })
        .catch(() => {})
    }
    socket.on(WS_EVENTS_V2.QUEUE_UPDATED, handleQueueUpdated)

    const handleChatMessage = (msg: any) => addChatMessage(msg)
    socket.on(WS_EVENTS_V2.CHAT_MESSAGE, handleChatMessage)

    const handleListenerJoined = (data: any) => {
      const s = useStationStore.getState()
      if (s.station && typeof data?.listenerCount === 'number') {
        s.setStation({ ...s.station, listenerCount: data.listenerCount })
      }

      const joinedMember = data?.member
      if (!joinedMember?.user?.id) return

      const existing = s.members.find((m) => m.user.id === joinedMember.user.id)
      if (existing) {
        s.setMembers(
          s.members.map((m) => (m.user.id === joinedMember.user.id ? { ...m, ...joinedMember, isOnline: true } : m)),
        )
        return
      }

      s.setMembers([...s.members, { ...joinedMember, isOnline: true }])
    }
    socket.on(WS_EVENTS_V2.LISTENER_JOINED, handleListenerJoined)

    const handleListenerLeft = (data: any) => {
      const s = useStationStore.getState()
      if (s.station && typeof data?.listenerCount === 'number') {
        s.setStation({ ...s.station, listenerCount: data.listenerCount })
      }
      if (!data?.userId) return
      s.setMembers(s.members.map((m) => (m.user.id === data.userId ? { ...m, isOnline: false } : m)))
    }
    socket.on(WS_EVENTS_V2.LISTENER_LEFT, handleListenerLeft)

    const handleConnect = () => {
      setConnected(true)
      setConnecting(false)
    }
    socket.on('connect', handleConnect)

    const handleDisconnect = () => setConnected(false)
    socket.on('disconnect', handleDisconnect)

    const heartbeat = setInterval(() => {
      socket.emit(WS_EVENTS_V2.HEARTBEAT)
    }, 30_000)

    requestTimeSync()
    const timeSync = setInterval(requestTimeSync, TIME_SYNC_INTERVAL_MS)
    const streamInfoRefresh = setInterval(() => {
      if (cancelled) return
      void refreshStreamInfo()
    }, 10_000)

    const ticker = setInterval(() => {
      const s = useStationStore.getState()
      const { isPaused, currentTrack, currentPosition } = s.playback
      const isDirectPlayback = s.station?.playbackMode === 'DIRECT'
      const audioConnectionState = s.audioConnectionState
      const pending = pendingTrackSyncRef.current
      const pendingActive =
        !!pending &&
        !!currentTrack &&
        pending.trackId === currentTrack.id &&
        audioConnectionState !== 'playing'
      if (pending && !pendingActive) {
        pendingTrackSyncRef.current = null
      }
      if (pendingActive) {
        localTickAnchorRef.current = Date.now()
        return
      }
      const directAudio = isDirectPlayback ? activeAudioRef.current.audioRef.current : null
      if (
        isDirectPlayback &&
        currentTrack &&
        !isPaused &&
        directAudio &&
        directAudio.readyState >= 1
      ) {
        const nextPosition = Math.min(
          currentTrack.duration > 0 ? currentTrack.duration : Number.POSITIVE_INFINITY,
          Math.max(0, directAudio.currentTime),
        )
        s.setPlayback({
          currentPosition: nextPosition,
        })
        localTickAnchorRef.current = Date.now()
      } else if (!isPaused && currentTrack && audioConnectionState === 'playing') {
        const now = Date.now()
        const last = localTickAnchorRef.current ?? now
        localTickAnchorRef.current = now
        const deltaSec = Math.max(0, (now - last) / 1000)
        const nextPosition = Math.min(
          currentTrack.duration > 0 ? currentTrack.duration : Number.POSITIVE_INFINITY,
          Math.max(0, currentPosition + deltaSec),
        )
        s.setPlayback({
          currentPosition: nextPosition,
        })
      } else {
        localTickAnchorRef.current = Date.now()
      }
    }, 250)

    return () => {
      cancelled = true
      socket.emit(WS_EVENTS_V2.STATION_LEAVE)
      socket.off(WS_EVENTS_V2.STATION_STATE, handleStationState)
      socket.off(WS_EVENTS_V2.TRACK_CHANGED, handleTrackChanged)
      socket.off(WS_EVENTS_V2.PLAYBACK_SYNC, handlePlaybackSync)
      socket.off(WS_EVENTS_V2.QUEUE_UPDATED, handleQueueUpdated)
      socket.off(WS_EVENTS_V2.CHAT_MESSAGE, handleChatMessage)
      socket.off(WS_EVENTS_V2.LISTENER_JOINED, handleListenerJoined)
      socket.off(WS_EVENTS_V2.LISTENER_LEFT, handleListenerLeft)
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.disconnect()
      clearInterval(heartbeat)
      clearInterval(timeSync)
      clearInterval(streamInfoRefresh)
      clearInterval(ticker)
      reset()
    }
  }, [addChatMessage, code, joinPassword, registerTimeSyncSample, reset, setConnected, setConnecting, setMembers, setPlayback, setQueue, setStation, setStationStreamUrl, socket])

  const sendPlaybackControl = useCallback(
    async (action: string, position?: number, value?: string) => {
      const stationId = useStationStore.getState().station?.id
      const shuffleEnabled = useStationStore.getState().playback.shuffleEnabled

      const command = (() => {
        switch (action) {
          case 'play':
            return { type: PlaybackCommandType.PLAY as const }
          case 'pause':
            return { type: PlaybackCommandType.PAUSE as const }
          case 'prev':
            return { type: PlaybackCommandType.PREVIOUS as const }
          case 'skip':
            return { type: PlaybackCommandType.SKIP as const }
          case 'seek':
            return typeof position === 'number' && Number.isFinite(position)
              ? { type: PlaybackCommandType.SEEK as const, payload: { position: Math.max(0, position) } }
              : null
          case 'set_loop':
            return value ? { type: PlaybackCommandType.SET_LOOP as const, payload: { loopMode: value } } : null
          case 'set_shuffle':
            return {
              type: PlaybackCommandType.SET_SHUFFLE as const,
              payload: { shuffleEnabled: !shuffleEnabled },
            }
          default:
            return null
        }
      })()

      if (!stationId || !command) return

      // Optimistic UI update — apply state change immediately before server confirms.
      const now = Date.now()
      const s = useStationStore.getState()
      const directAudio = s.station?.playbackMode === 'DIRECT' ? activeAudioRef.current.audioRef.current : null
      const directAudioPosition =
        directAudio && Number.isFinite(directAudio.currentTime) ? Math.max(0, directAudio.currentTime) : null
      const directTransitionAction =
        s.station?.playbackMode === 'DIRECT' && (action === 'skip' || action === 'prev')
      if (directTransitionAction) {
        activeAudioRef.current.beginTransition(
          action === 'prev' ? 'Switching to previous track...' : 'Switching to next track...',
        )
      }

      if (action === 'play' || action === 'pause') {
        playPauseIntentRef.current = {
          action,
          trackId: s.playback.currentTrack?.id ?? null,
          expiresAt: now + PLAY_PAUSE_INTENT_GRACE_MS,
        }
        seekIntentRef.current = null
      }

      if (action === 'pause') {
        const currentPosition =
          directAudioPosition ??
          (s.playback.trackStartedAt ? (now - s.playback.trackStartedAt) / 1000 : s.playback.currentPosition)
        setPlayback({ isPaused: true, isPlaying: false, currentPosition })
        localTickAnchorRef.current = now
      } else if (action === 'play') {
        const currentPosition = directAudioPosition ?? s.playback.currentPosition
        setPlayback({
          isPaused: false,
          isPlaying: !!s.playback.currentTrack,
          currentPosition,
          trackStartedAt: now - currentPosition * 1000,
        })
        localTickAnchorRef.current = now
      } else if (action === 'seek' && typeof position === 'number' && Number.isFinite(position)) {
        const clampedPos = Math.max(0, position)
        seekIntentRef.current = {
          trackId: s.playback.currentTrack?.id ?? null,
          targetPosition: clampedPos,
          expiresAt: now + SEEK_INTENT_GRACE_MS,
        }
        const nextStartedAt = s.playback.isPaused ? null : now - clampedPos * 1000
        setPlayback({ currentPosition: clampedPos, trackStartedAt: nextStartedAt })
        localTickAnchorRef.current = now
      }

      await api.post(`/stations/${stationId}/playback/commands`, command)
    },
    [setPlayback],
  )

  const sendChatMessage = useCallback(
    (content: string) => {
      socket.emit(WS_EVENTS_V2.CHAT_SEND, { content })
    },
    [socket],
  )

  const restartAudio = useCallback(() => {
    void audio.restartAudio()
    useStationStore.getState().setAudioNeedsRestart(false)
  }, [audio])

  const addToQueue = useCallback(async (trackId: string, options?: { mode?: 'end' | 'next' | 'now'; beforeItemId?: string }) => {
    const state = useStationStore.getState()
    const stationId = state.station?.id
    if (!stationId) return

    await api.post(`/stations/${stationId}/playback/commands`, {
      type: PlaybackCommandType.QUEUE_ADD,
      payload: {
        trackId,
        mode: options?.mode ?? 'end',
        ...(options?.beforeItemId ? { beforeItemId: options.beforeItemId } : {}),
      },
    })
  }, [])

  const removeFromQueue = useCallback(async (itemId: string) => {
    const state = useStationStore.getState()
    const stationId = state.station?.id
    state.setQueue(state.queue.filter((item) => item.id !== itemId))
    if (stationId) {
      await api.post(`/stations/${stationId}/playback/commands`, {
        type: PlaybackCommandType.QUEUE_REMOVE,
        payload: { itemId },
      })
    }
  }, [])

  const reorderQueue = useCallback(async (items: Array<{ id: string; position: number }>) => {
    const stationId = useStationStore.getState().station?.id
    if (!stationId) return

    const state = useStationStore.getState()
    const positionById = new Map(items.map((item) => [item.id, item.position]))
    state.setQueue(
      [...state.queue].sort((a, b) => {
        const aPos = positionById.get(a.id)
        const bPos = positionById.get(b.id)
        if (aPos == null && bPos == null) return 0
        if (aPos == null) return 1
        if (bPos == null) return -1
        return aPos - bPos
      }),
    )

    await api.post(`/stations/${stationId}/playback/commands`, {
      type: PlaybackCommandType.QUEUE_REORDER,
      payload: { items },
    })
  }, [])

  return {
    ...store,
    effectiveTrackDuration,
    audioNeedsRestart: audio.audioNeedsRestart,
    audioConnectionState: audio.audioConnectionState,
    audioConnectionMessage: audio.audioConnectionMessage,
    audioDiagnostics: audio.audioDiagnostics,
    sendPlaybackControl,
    sendChatMessage,
    restartAudio,
    addToQueue,
    removeFromQueue,
    reorderQueue,
  }
}
