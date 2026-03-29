'use client'

import { useCallback, useEffect, useRef } from 'react'
import { PlaybackCommandType, WS_EVENTS_V2 } from '@web-radio/shared'
import { getSocket } from '@/lib/socket'
import api, { fetchStationStreamInfo } from '@/lib/api'
import { useStationStore } from '@/stores/station.store'
import { useAudioStore } from '@/stores/audio.store'
import { useRadioPlaybackEngine, normalizeTrackStartedAt } from './useRadioPlaybackEngine'

const TIME_SYNC_INTERVAL_MS = 15_000
const TIME_SYNC_EMA_ALPHA = 0.2

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

  const audio = useRadioPlaybackEngine({
    streamUrl: store.stationStreamUrl,
    isPlaying: !!store.playback.currentTrack && !store.playback.isPaused,
    volume,
  })

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
      setStation(state.station)
      setQueue(state.queue ?? [])
      setMembers(state.members ?? [])
        setPlayback({
          currentTrack: state.currentTrack ?? null,
          currentQueueType: state.currentQueueType ?? null,
          isPaused: state.isPaused ?? false,
          trackStartedAt: startedAt,
          currentPosition:
            typeof state.currentPosition === 'number' && Number.isFinite(state.currentPosition)
              ? Math.max(0, state.currentPosition)
              : 0,
          isPlaying: !!state.currentTrack && !state.isPaused,
        })
      if (!nextTrackId) {
        pendingTrackSyncRef.current = null
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
      const previousTrackId = useStationStore.getState().playback.currentTrack?.id ?? null
      const nextTrack = data.track ?? null
      const startedAt = normalizeTrackStartedAt(data.trackStartedAt)

      setPlayback({
        currentTrack: nextTrack,
        currentQueueType: data.currentQueueType ?? null,
        trackStartedAt: startedAt,
        isPaused: data.isPaused ?? false,
        currentPosition:
          typeof data.currentPosition === 'number' && Number.isFinite(data.currentPosition)
            ? Math.max(0, data.currentPosition)
            : 0,
        isPlaying: !!nextTrack && !data.isPaused,
      })
      localTickAnchorRef.current = Date.now()
      const nextTrackId = nextTrack?.id ?? null
      if (nextTrackId && nextTrackId !== previousTrackId) {
        pendingTrackSyncRef.current = { trackId: nextTrackId, sinceMs: Date.now() }
        void audio.restartAudio()
      } else if (!nextTrackId) {
        pendingTrackSyncRef.current = null
      }

      if (data.queue) setQueue(data.queue)
      if (!nextTrack && data.currentTrackId) {
        void refreshStationSnapshot()
      }
    }
    socket.on(WS_EVENTS_V2.TRACK_CHANGED, handleTrackChanged)

    const handlePlaybackSync = (data: any) => {
      const currentTrackId = useStationStore.getState().playback.currentTrack?.id
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

      const targetPosition =
        freezePositionWhileReconnecting
          ? useStationStore.getState().playback.currentPosition
          : typeof data.position === 'number' && Number.isFinite(data.position)
          ? Math.max(0, data.position)
          : typeof data.currentPosition === 'number' && Number.isFinite(data.currentPosition)
            ? Math.max(0, data.currentPosition)
            : useStationStore.getState().playback.currentPosition
      const nextIsPaused =
        typeof data.isPaused === 'boolean' ? data.isPaused : useStationStore.getState().playback.isPaused
      const nextTrackStartedAt =
        normalizeTrackStartedAt(data.trackStartedAt) ?? useStationStore.getState().playback.trackStartedAt

      setPlayback({
        currentPosition: targetPosition,
        isPaused: nextIsPaused,
        trackStartedAt: nextTrackStartedAt,
        ...(data.currentQueueType !== undefined && { currentQueueType: data.currentQueueType }),
        ...(data.loopMode !== undefined && { loopMode: data.loopMode }),
        ...(data.shuffleEnabled !== undefined && { shuffleEnabled: data.shuffleEnabled }),
      })
      localTickAnchorRef.current = Date.now()
      if (Array.isArray(data?.queue)) {
        setQueue(data.queue)
      }

      audio.reportDrift({
        targetPosition,
        actualPosition: audio.audioRef.current?.currentTime ?? null,
        syncType: typeof data.syncType === 'string' ? data.syncType : typeof data.sourceType === 'string' ? data.sourceType : 'ws-sync',
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
      const pending = pendingTrackSyncRef.current
      const pendingActive =
        !!pending &&
        !!currentTrack &&
        pending.trackId === currentTrack.id &&
        useStationStore.getState().audioConnectionState !== 'playing'
      if (pending && !pendingActive) {
        pendingTrackSyncRef.current = null
      }
      if (pendingActive) {
        localTickAnchorRef.current = Date.now()
        return
      }
      if (!isPaused && currentTrack && audio.audioConnectionState === 'playing') {
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

      if (stationId && command) {
        await api.post(`/stations/${stationId}/playback/commands`, command)
      }
    },
    [],
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
