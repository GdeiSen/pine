'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ListenOnlyPlayerCard } from '@/components/station/listen-only-player-card'
import { useAudioStore } from '@/stores/audio.store'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api'
const POLL_INTERVAL_MS = 4000
const SYNC_DRIFT_SECONDS = 1.2

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
}

function getServerPosition(state: PublicListenState): number {
  if (state.isPaused) return state.pausedPosition ?? state.currentPosition ?? 0
  if (state.trackStartedAt) {
    const startedAtMs = Date.parse(state.trackStartedAt)
    if (!Number.isNaN(startedAtMs)) {
      return Math.max(0, (Date.now() - startedAtMs) / 1000)
    }
  }
  return state.currentPosition ?? 0
}

export function PublicListenPlayer({ code, initialState }: { code: string; initialState: PublicListenState }) {
  const [state, setState] = useState<PublicListenState>(initialState)
  const [displayPosition, setDisplayPosition] = useState(() => getServerPosition(initialState))
  const [needsGesture, setNeedsGesture] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const trackIdRef = useRef<string | null>(null)
  const volume = useAudioStore((s) => s.volume)

  const hasTrackSource = useCallback((audio: HTMLAudioElement, trackId: string) => {
    return audio.currentSrc.includes(`/tracks/${trackId}/stream`)
  }, [])

  const restartAudio = useCallback(async () => {
    const audio = audioRef.current
    if (!audio || !state.currentTrackId) return

    audio.volume = volume

    if (trackIdRef.current !== state.currentTrackId || !hasTrackSource(audio, state.currentTrackId)) {
      trackIdRef.current = state.currentTrackId
      audio.src = `${API_URL}/tracks/${state.currentTrackId}/stream?quality=LOW`
      audio.load()
      if (audio.readyState < 1) {
        await new Promise<void>((resolve) => {
          audio.addEventListener('loadedmetadata', () => resolve(), { once: true })
        })
      }
    }

    audio.currentTime = getServerPosition(state)
    try {
      await audio.play()
      setNeedsGesture(false)
    } catch {
      setNeedsGesture(true)
    }
  }, [hasTrackSource, state, volume])

  const syncPlayback = useCallback(async (next: PublicListenState) => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = volume

    if (!next.currentTrackId) {
      audio.pause()
      trackIdRef.current = null
      return
    }

    const serverPosition = getServerPosition(next)
    const isTrackChanged = trackIdRef.current !== next.currentTrackId
    const isSourceMissing = !hasTrackSource(audio, next.currentTrackId)

    if (isTrackChanged || isSourceMissing) {
      trackIdRef.current = next.currentTrackId
      audio.src = `${API_URL}/tracks/${next.currentTrackId}/stream?quality=LOW`
      audio.load()
      audio.currentTime = 0
      audio.addEventListener(
        'loadedmetadata',
        () => {
          if (Math.abs(audio.currentTime - serverPosition) > SYNC_DRIFT_SECONDS) {
            audio.currentTime = serverPosition
          }
        },
        { once: true },
      )
    } else if (Math.abs(audio.currentTime - serverPosition) > SYNC_DRIFT_SECONDS) {
      audio.currentTime = serverPosition
    }

    if (next.isPaused) {
      if (!audio.paused) audio.pause()
      return
    }

    if (audio.paused) {
      try {
        await audio.play()
        setNeedsGesture(false)
      } catch {
        setNeedsGesture(true)
      }
    }
  }, [hasTrackSource, volume])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = volume
  }, [volume])

  useEffect(() => {
    void syncPlayback(state)
  }, [state, syncPlayback])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setDisplayPosition(getServerPosition(state))
    }, 250)
    return () => window.clearInterval(timer)
  }, [state])

  useEffect(() => {
    let cancelled = false

    const pullState = async () => {
      try {
        const res = await fetch(`${API_URL}/stations/${code}`, { cache: 'no-store' })
        if (!res.ok) return
        const next = (await res.json()) as PublicListenState
        if (cancelled) return
        if (next.accessMode !== 'PUBLIC' || next.isPasswordProtected) return

        setState((prev) => ({
          ...prev,
          name: next.name ?? prev.name,
          listenerCount: next.listenerCount ?? prev.listenerCount,
          currentTrackId: next.currentTrackId ?? null,
          currentTrack: next.currentTrack ?? null,
          currentPosition: next.currentPosition ?? 0,
          isPaused: next.isPaused ?? false,
          trackStartedAt: next.trackStartedAt ?? null,
          pausedPosition: next.pausedPosition ?? 0,
        }))
      } catch {
        // keep previous state on transient network errors
      }
    }

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
      <audio ref={audioRef} preload="auto" className="hidden" />
      <ListenOnlyPlayerCard
        track={state.currentTrack}
        currentPosition={displayPosition}
        isPaused={!!state.isPaused}
        isPlaying={!state.isPaused}
        listenerCount={state.listenerCount ?? 0}
        stationName={state.name}
        stationCode={state.code}
        audioNeedsRestart={needsGesture}
        onRestartAudio={restartAudio}
      />
    </div>
  )
}
