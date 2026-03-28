'use client'

import { useEffect, useRef, useCallback } from 'react'
import { Howl, Howler } from 'howler'
import { getSocket } from '@/lib/socket'
import api from '@/lib/api'
import { useStationStore } from '@/stores/station.store'
import { useAudioStore } from '@/stores/audio.store'
// re-export store for direct getState() access inside intervals
const stationStore = useStationStore
import { WS_EVENTS, SYNC_THRESHOLD_SECONDS } from '@web-radio/shared'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api'
const TIME_SYNC_INTERVAL_MS = 15_000
const TIME_SYNC_EMA_ALPHA = 0.2
const HARD_SYNC_DRIFT_SECONDS = Math.max(SYNC_THRESHOLD_SECONDS * 2, 4)
const HTML5_POOL_SIZE = 16

const howlerGlobal = Howler as any
howlerGlobal.html5PoolSize = Math.max(howlerGlobal.html5PoolSize ?? 0, HTML5_POOL_SIZE)

export function useStation(code: string, joinPassword?: string | null) {
  const store = useStationStore()
  const volume = useAudioStore((s) => s.volume)
  const howlRef = useRef<Howl | null>(null)
  const soundIdRef = useRef<number | null>(null)
  const playbackTokenRef = useRef(0)
  const serverOffsetRef = useRef<number | null>(null)
  const bestServerOffsetRef = useRef<{ offsetMs: number; rttMs: number } | null>(null)
  const socket = getSocket()

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
  }, [
    store.playback.currentTrack?.id,
    store.playback.currentTrack?.title,
    store.playback.currentTrack?.artist,
    store.station?.name,
  ])

  useEffect(() => {
    return () => {
      if (typeof document !== 'undefined') {
        document.title = 'PINE'
      }
    }
  }, [])

  const getStreamUrl = (trackId: string) => {
    const quality = stationStore.getState().station?.streamQuality ?? 'HIGH'
    return `${API_URL}/tracks/${trackId}/stream?quality=${quality}`
  }

  const destroyHowl = useCallback(() => {
    if (!howlRef.current) return

    howlRef.current.off()
    howlRef.current.stop()
    howlRef.current.unload()
    howlRef.current = null
    soundIdRef.current = null
  }, [])

  const getEstimatedServerNow = useCallback(() => {
    return Date.now() + (serverOffsetRef.current ?? 0)
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

  const getStartPositionFromServer = useCallback((trackStartedAt?: number | null, duration?: number | null) => {
    if (!trackStartedAt) return 0

    const estimatedPosition = Math.max(0, (getEstimatedServerNow() - trackStartedAt) / 1000)
    if (typeof duration === 'number' && Number.isFinite(duration)) {
      return Math.min(estimatedPosition, Math.max(0, duration - 0.25))
    }

    return estimatedPosition
  }, [getEstimatedServerNow])

  const playTrack = useCallback((trackId: string, startPosition = 0, shouldStartPlaying = true) => {
    const token = ++playbackTokenRef.current
    destroyHowl()

    const getState = () => stationStore.getState()

    const applyIfCurrent = (fn: () => void) => {
      if (playbackTokenRef.current !== token || howlRef.current !== howl) return
      fn()
    }

    const howl = new Howl({
      src: [getStreamUrl(trackId)],
      html5: true,
      pool: 10,
      volume: useAudioStore.getState().volume,
      preload: true,
      format: ['mp3', 'flac', 'wav', 'aac', 'ogg'],
      onload: () => {
        applyIfCurrent(() => {
          const initialPosition = Math.max(0, startPosition)
          howl.seek(initialPosition)
          howl.rate(1)
          if (shouldStartPlaying) {
            const nextSoundId = howl.play()
            if (typeof nextSoundId === 'number') {
              soundIdRef.current = nextSoundId
            }
            getState().setPlayback({ currentPosition: initialPosition, isPlaying: true, isPaused: false })
          } else {
            getState().setPlayback({ currentPosition: initialPosition, isPlaying: false, isPaused: true })
          }
        })
      },
      onplay: (id) => {
        applyIfCurrent(() => {
          soundIdRef.current = id
          getState().setAudioNeedsRestart(false)
          getState().setPlayback({ isPlaying: true, isPaused: false })
        })
      },
      onpause: (id) => {
        applyIfCurrent(() => {
          if (soundIdRef.current === id) {
            getState().setPlayback({ isPaused: true })
          }
        })
      },
      onstop: (id) => {
        applyIfCurrent(() => {
          if (soundIdRef.current === id) {
            getState().setPlayback({ isPlaying: false, isPaused: true })
          }
        })
      },
      onend: (id) => {
        applyIfCurrent(() => {
          if (soundIdRef.current === id) {
            getState().setPlayback({ isPlaying: false, isPaused: true })
          }
        })
      },
      onloaderror: (_, err) => {
        applyIfCurrent(() => {
          console.error('Howl load error:', err)
        })
      },
      onplayerror: () => {
        applyIfCurrent(() => {
          getState().setAudioNeedsRestart(true)
        })
      },
    })

    howlRef.current = howl
  }, [destroyHowl])

  useEffect(() => {
    if (!howlRef.current) return
    howlRef.current.volume(volume)
  }, [volume])

  useEffect(() => {
    if (!code) return

    const getState = () => stationStore.getState()
    const setConnecting = (value: boolean) => getState().setConnecting(value)
    const setConnected = (value: boolean) => getState().setConnected(value)

    setConnecting(true)
    socket.connect()

    // Join station
    socket.emit(WS_EVENTS.STATION_JOIN, {
      code,
      ...(joinPassword ? { password: joinPassword } : {}),
    })

    const requestTimeSync = () => {
      const clientTs = Date.now()
      socket.emit(WS_EVENTS.TIME_SYNC, { clientTs }, (ack?: { clientTs?: number; serverTs?: number }) => {
        if (!ack || ack.clientTs !== clientTs || typeof ack.serverTs !== 'number') return
        registerTimeSyncSample(clientTs, ack.serverTs)
      })
    }

    const handleStationState = (state: any) => {
      const s = getState()
      s.setStation(state.station)
      s.setQueue(state.queue ?? [])
      s.setMembers(state.members ?? [])
      s.setPlayback({
        loopMode: state.loopMode ?? 'none',
        shuffleEnabled: state.shuffleEnabled ?? false,
      })

      if (state.currentTrack) {
        const startPosition = getStartPositionFromServer(state.trackStartedAt, state.currentTrack.duration)
        s.setPlayback({
          currentTrack: state.currentTrack,
          currentQueueType: state.currentQueueType ?? null,
          isPaused: state.isPaused,
          trackStartedAt: state.trackStartedAt,
          currentPosition: startPosition,
          isPlaying: !state.isPaused,
        })

        playTrack(state.currentTrack.id, startPosition, !state.isPaused)
      }

      setConnected(true)
      setConnecting(false)
    }
    socket.on(WS_EVENTS.STATION_STATE, handleStationState)

    const handleTrackChanged = (data: any) => {
      const nextTrack = data.track ?? null
      const startPosition = nextTrack
        ? getStartPositionFromServer(data.trackStartedAt, nextTrack.duration)
        : 0

      getState().setPlayback({
        currentTrack: nextTrack,
        currentQueueType: data.currentQueueType ?? null,
        trackStartedAt: data.trackStartedAt,
        isPaused: false,
        currentPosition: 0,
        isPlaying: !!nextTrack,
      })
      if (data.queue) getState().setQueue(data.queue)

      if (nextTrack) {
        playTrack(nextTrack.id, startPosition)
      } else {
        destroyHowl()
        getState().setPlayback({ isPlaying: false, isPaused: true })
      }
    }
    socket.on(WS_EVENTS.TRACK_CHANGED, handleTrackChanged)

    const handlePlaybackSync = (data: any) => {
      const currentTrackId = getState().playback.currentTrack?.id
      if (data.currentTrackId && data.currentTrackId !== currentTrackId) {
        return
      }

      const targetPosition = typeof data.position === 'number' && Number.isFinite(data.position)
        ? Math.max(0, data.position)
        : getState().playback.currentPosition
      const nextIsPaused = typeof data.isPaused === 'boolean' ? data.isPaused : getState().playback.isPaused
      const nextTrackStartedAt = typeof data.trackStartedAt === 'number' ? data.trackStartedAt : getState().playback.trackStartedAt

      getState().setPlayback({
        currentPosition: targetPosition,
        isPaused: nextIsPaused,
        trackStartedAt: nextTrackStartedAt,
        ...(data.currentQueueType !== undefined && { currentQueueType: data.currentQueueType }),
        ...(data.loopMode !== undefined && { loopMode: data.loopMode }),
        ...(data.shuffleEnabled !== undefined && { shuffleEnabled: data.shuffleEnabled }),
      })

      const howl = howlRef.current
      if (!howl) return
      const soundId = soundIdRef.current ?? undefined
      const syncType = data.syncType ?? data.type ?? 'heartbeat'

      if (!nextIsPaused && howl.state() === 'loaded') {
        const currentSeekRaw = howl.seek(soundId)
        const currentSeek = typeof currentSeekRaw === 'number' ? currentSeekRaw : 0
        const diff = currentSeek - targetPosition // positive = client ahead, negative = behind
        const absDiff = Math.abs(diff)
        const isHardSync = syncType === 'control' || syncType === 'track_changed'
        const shouldHardSeek = isHardSync || absDiff >= HARD_SYNC_DRIFT_SECONDS || (syncType !== 'heartbeat' && absDiff > SYNC_THRESHOLD_SECONDS)

        if (shouldHardSeek) {
          howl.seek(targetPosition, soundId)
          howl.rate(1, soundId)
          getState().setPlayback({ currentPosition: targetPosition })
        } else if (soundId !== undefined) {
          // Keep pitch/timbre stable on heartbeat syncs: no playbackRate nudging.
          howl.rate(1, soundId)
        }

        // Do not auto-create additional sound instances here.
        // If browser blocks autoplay, we show explicit restart UI to avoid layered streams.
        if (soundId !== undefined && !howl.playing(soundId)) {
          howl.play(soundId)
        }
      }

      if (nextIsPaused && soundId !== undefined && howl.playing(soundId)) {
        howl.pause(soundId)
        howl.rate(1, soundId)
      }
    }
    socket.on(WS_EVENTS.PLAYBACK_SYNC, handlePlaybackSync)

    const handleQueueUpdated = (data: any) => getState().setQueue(data.queue)
    socket.on(WS_EVENTS.QUEUE_UPDATED, handleQueueUpdated)

    const handleChatMessage = (msg: any) => getState().addChatMessage(msg)
    socket.on(WS_EVENTS.CHAT_MESSAGE, handleChatMessage)

    const handleListenerJoined = (data: any) => {
      const s = stationStore.getState()
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
    socket.on(WS_EVENTS.LISTENER_JOINED, handleListenerJoined)

    const handleListenerLeft = (data: any) => {
      const s = stationStore.getState()
      if (s.station && typeof data?.listenerCount === 'number') {
        s.setStation({ ...s.station, listenerCount: data.listenerCount })
      }
      if (!data?.userId) return
      s.setMembers(
        s.members.map((m) => (m.user.id === data.userId ? { ...m, isOnline: false } : m)),
      )
    }
    socket.on(WS_EVENTS.LISTENER_LEFT, handleListenerLeft)

    const handleConnect = () => {
      setConnected(true)
      setConnecting(false)
    }
    socket.on('connect', handleConnect)

    const handleDisconnect = () => setConnected(false)
    socket.on('disconnect', handleDisconnect)

    // Heartbeat
    const heartbeat = setInterval(() => {
      socket.emit(WS_EVENTS.HEARTBEAT)
    }, 30_000)

    requestTimeSync()
    const timeSync = setInterval(requestTimeSync, TIME_SYNC_INTERVAL_MS)

    // Smooth progress bar — update position locally every 250ms
    const ticker = setInterval(() => {
      const s = stationStore.getState()
      const { isPaused, trackStartedAt } = s.playback
      if (!isPaused && trackStartedAt) {
        s.setPlayback({ currentPosition: Math.max(0, (getEstimatedServerNow() - trackStartedAt) / 1000) })
      }
    }, 250)

    return () => {
      socket.emit(WS_EVENTS.STATION_LEAVE)
      socket.off(WS_EVENTS.STATION_STATE, handleStationState)
      socket.off(WS_EVENTS.TRACK_CHANGED, handleTrackChanged)
      socket.off(WS_EVENTS.PLAYBACK_SYNC, handlePlaybackSync)
      socket.off(WS_EVENTS.QUEUE_UPDATED, handleQueueUpdated)
      socket.off(WS_EVENTS.CHAT_MESSAGE, handleChatMessage)
      socket.off(WS_EVENTS.LISTENER_JOINED, handleListenerJoined)
      socket.off(WS_EVENTS.LISTENER_LEFT, handleListenerLeft)
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.disconnect()
      playbackTokenRef.current += 1
      destroyHowl()
      clearInterval(heartbeat)
      clearInterval(timeSync)
      clearInterval(ticker)
      getState().reset()
    }
  }, [code, joinPassword, destroyHowl, getEstimatedServerNow, getStartPositionFromServer, playTrack, registerTimeSyncSample, socket])

  const sendPlaybackControl = useCallback(
    (action: string, position?: number, value?: string) => {
      socket.emit(WS_EVENTS.PLAYBACK_CONTROL, { action, position, value })
    },
    [socket],
  )

  const sendChatMessage = useCallback((content: string) => {
    socket.emit(WS_EVENTS.CHAT_SEND, { content })
  }, [socket])

  const restartAudio = useCallback(() => {
    const s = stationStore.getState()
    if (s.playback.currentTrack) {
      const serverPosition = getStartPositionFromServer(s.playback.trackStartedAt, s.playback.currentTrack.duration)
      const startPosition = s.playback.isPaused
        ? s.playback.currentPosition
        : serverPosition

      // Strictly local reconnect:
      // - never sends playback commands to the server
      // - only re-creates client audio at current synced position
      playTrack(
        s.playback.currentTrack.id,
        startPosition,
        !s.playback.isPaused,
      )
    }

    s.setAudioNeedsRestart(false)
  }, [getStartPositionFromServer, playTrack])

  const addToQueue = useCallback(
    (
      trackId: string,
      options?: { mode?: 'end' | 'next' | 'now'; beforeItemId?: string },
    ) => {
      socket.emit(WS_EVENTS.QUEUE_ADD, { trackId, ...options })
    },
    [socket],
  )

  const removeFromQueue = useCallback((itemId: string) => {
    const state = stationStore.getState()
    const stationId = state.station?.id

    // Optimistic local update for instant UI feedback.
    state.setQueue(state.queue.filter((item) => item.id !== itemId))

    // Primary path: WebSocket (keeps all listeners in sync).
    socket.emit(WS_EVENTS.QUEUE_REMOVE, { itemId })

    // Fallback path: HTTP endpoint (works even if WS event is not processed).
    if (stationId) {
      api.delete(`/stations/${stationId}/queue/${itemId}`).catch(() => {})
    }
  }, [socket])

  const reorderQueue = useCallback((items: Array<{ id: string; position: number }>) => {
    socket.emit(WS_EVENTS.QUEUE_REORDER, { items })
  }, [socket])

  return {
    ...store,
    sendPlaybackControl,
    sendChatMessage,
    restartAudio,
    addToQueue,
    removeFromQueue,
    reorderQueue,
    howl: howlRef.current,
  }
}
