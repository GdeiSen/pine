'use client'

import { useEffect, useRef, useState } from 'react'
import { ListenOnlyPlayerCard } from '@/components/station/listen-only-player-card'
import { useAudioStore } from '@/stores/audio.store'
import { useStationStore } from '@/stores/station.store'
import { fetchStationStreamInfo } from '@/lib/api'
import {
  getEstimatedServerPosition,
  getServerOffsetMs,
  normalizeTrackStartedAt,
  useRadioPlaybackEngine,
} from '@/hooks/useRadioPlaybackEngine'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api'
const POLL_INTERVAL_MS = 4000

interface PublicListenState {
  code: string
  name: string
  listenerCount: number
  accessMode: 'PUBLIC' | 'PRIVATE'
  isPasswordProtected: boolean
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

  const playback = useRadioPlaybackEngine({
    streamUrl: state.streamUrl ?? null,
    isPlaying: !!state.currentTrackId && !state.isPaused,
    volume,
  })

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
      setAudioConnection({
        state: 'idle',
        message: null,
        diagnostics: null,
      })
    }
  }, [setAudioConnection])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setState((prev) => ({
        ...prev,
        currentPosition: getEstimatedServerPosition({
          currentPosition: prev.currentPosition ?? 0,
          duration: prev.currentTrack?.duration ?? 0,
          isPaused: !!prev.isPaused,
          pausedPosition: prev.pausedPosition,
          serverOffsetMs: serverOffsetMsRef.current,
          trackStartedAt: normalizeTrackStartedAt(prev.trackStartedAt),
        }),
      }))
    }, 250)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let cancelled = false

    const pullState = async () => {
      try {
        const [stationResponse, streamInfo] = await Promise.all([
          fetch(`${API_URL}/stations/${code}`, { cache: 'no-store' }),
          fetchStationStreamInfo(code),
        ])
        if (!stationResponse.ok) return
        const next = (await stationResponse.json()) as PublicListenState
        if (cancelled) return
        if (next.accessMode !== 'PUBLIC' || next.isPasswordProtected) return

        const offsetMs = getServerOffsetMs(next.serverTime, Date.now())
        if (offsetMs !== null) {
          serverOffsetMsRef.current = offsetMs
        }

        const nextPosition = getEstimatedServerPosition({
          currentPosition: next.currentPosition ?? 0,
          duration: next.currentTrack?.duration ?? 0,
          isPaused: !!next.isPaused,
          pausedPosition: next.pausedPosition,
          serverOffsetMs: serverOffsetMsRef.current,
          trackStartedAt: normalizeTrackStartedAt(next.trackStartedAt),
        })

        setState((prev) => ({
          ...prev,
          name: next.name ?? prev.name,
          listenerCount: next.listenerCount ?? prev.listenerCount,
          currentTrackId: next.currentTrackId ?? null,
          currentTrack: next.currentTrack ?? null,
          currentPosition: nextPosition,
          isPaused: next.isPaused ?? false,
          trackStartedAt: next.trackStartedAt ?? null,
          pausedPosition: next.pausedPosition ?? 0,
          serverTime: next.serverTime ?? prev.serverTime ?? null,
          streamUrl: streamInfo?.streamUrl ?? null,
        }))

        playback.reportDrift({
          targetPosition: nextPosition,
          actualPosition: playback.audioRef.current?.currentTime ?? null,
          syncType: 'poll',
          rttMs: null,
        })
      } catch {
        // keep previous state on transient network errors
      }
    }

    void pullState()
    const intervalId = window.setInterval(() => {
      void pullState()
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [code])

  if (!state.currentTrackId || !state.currentTrack) {
    return <p className="text-xs text-[--text-muted] mt-6">Сейчас ничего не играет.</p>
  }

  return (
    <div className="w-full">
      <ListenOnlyPlayerCard
        track={state.currentTrack}
        currentPosition={state.currentPosition ?? 0}
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
