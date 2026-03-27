'use client'

import { useEffect, useRef, useCallback } from 'react'
import { Howl } from 'howler'
import { getSocket } from '@/lib/socket'
import api from '@/lib/api'
import { useStationStore } from '@/stores/station.store'
import { useAudioStore } from '@/stores/audio.store'
// re-export store for direct getState() access inside intervals
const stationStore = useStationStore
import { WS_EVENTS, SYNC_THRESHOLD_SECONDS } from '@web-radio/shared'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api'

export function useStation(code: string, joinPassword?: string | null) {
  const store = useStationStore()
  const volume = useAudioStore((s) => s.volume)
  const howlRef = useRef<Howl | null>(null)
  const soundIdRef = useRef<number | null>(null)
  const playbackTokenRef = useRef(0)
  const socket = getSocket()

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
      volume: useAudioStore.getState().volume,
      preload: true,
      format: ['mp3', 'flac', 'wav', 'aac', 'ogg'],
      onload: () => {
        applyIfCurrent(() => {
          howl.seek(startPosition)
          if (shouldStartPlaying) {
            const nextSoundId = howl.play()
            if (typeof nextSoundId === 'number') {
              soundIdRef.current = nextSoundId
            }
            getState().setPlayback({ isPlaying: true, isPaused: false })
          } else {
            getState().setPlayback({ isPlaying: false, isPaused: true })
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
        s.setPlayback({
          currentTrack: state.currentTrack,
          currentQueueType: state.currentQueueType ?? null,
          isPaused: state.isPaused,
          trackStartedAt: state.trackStartedAt,
        })

        // Calculate current position with latency compensation
        const now = Date.now()
        const position = state.trackStartedAt
          ? (now - state.trackStartedAt) / 1000
          : 0

        playTrack(state.currentTrack.id, position, !state.isPaused)
      }

      setConnected(true)
      setConnecting(false)
    }
    socket.on(WS_EVENTS.STATION_STATE, handleStationState)

    const handleTrackChanged = (data: any) => {
      getState().setPlayback({
        currentTrack: data.track,
        currentQueueType: data.currentQueueType ?? null,
        trackStartedAt: data.trackStartedAt,
        isPaused: false,
        isPlaying: !!data.track,
      })
      if (data.queue) getState().setQueue(data.queue)

      if (data.track) {
        playTrack(data.track.id, 0)
      } else {
        destroyHowl()
        getState().setPlayback({ isPlaying: false, isPaused: true })
      }
    }
    socket.on(WS_EVENTS.TRACK_CHANGED, handleTrackChanged)

    const handlePlaybackSync = (data: any) => {
      getState().setPlayback({
        currentPosition: data.position,
        isPaused: data.isPaused,
        trackStartedAt: data.trackStartedAt,
        ...(data.currentQueueType !== undefined && { currentQueueType: data.currentQueueType }),
        ...(data.loopMode !== undefined && { loopMode: data.loopMode }),
        ...(data.shuffleEnabled !== undefined && { shuffleEnabled: data.shuffleEnabled }),
      })

      const howl = howlRef.current
      if (!howl) return
      const soundId = soundIdRef.current ?? undefined

      if (!data.isPaused && howl.state() === 'loaded') {
        const currentSeekRaw = howl.seek(soundId)
        const currentSeek = typeof currentSeekRaw === 'number' ? currentSeekRaw : 0
        const diff = currentSeek - data.position // positive = client ahead, negative = behind
        const absDiff = Math.abs(diff)

        // Seek if drift exceeds threshold OR if the server jumped backwards (prev/seek)
        if (absDiff > SYNC_THRESHOLD_SECONDS || diff > 1) {
          howl.seek(data.position, soundId)
        }

        // Do not auto-create additional sound instances here.
        // If browser blocks autoplay, we show explicit restart UI to avoid layered streams.
        if (soundId !== undefined && !howl.playing(soundId)) {
          howl.play(soundId)
        }
      }

      if (data.isPaused && soundId !== undefined && howl.playing(soundId)) {
        howl.pause(soundId)
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

    // Smooth progress bar — update position locally every 250ms
    const ticker = setInterval(() => {
      const s = stationStore.getState()
      const { isPaused, trackStartedAt } = s.playback
      if (!isPaused && trackStartedAt) {
        s.setPlayback({ currentPosition: (Date.now() - trackStartedAt) / 1000 })
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
      clearInterval(ticker)
      getState().reset()
    }
  }, [code, joinPassword, destroyHowl, playTrack, socket])

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
      const serverPosition = s.playback.trackStartedAt
        ? Math.max(0, (Date.now() - s.playback.trackStartedAt) / 1000)
        : s.playback.currentPosition
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
  }, [playTrack])

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
