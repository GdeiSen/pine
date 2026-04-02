import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PlaybackQualityPreference } from '@web-radio/shared'

interface AudioState {
  volume: number
  playbackQuality: PlaybackQualityPreference
  setVolume: (volume: number) => void
  setPlaybackQuality: (quality: PlaybackQualityPreference) => void
}

function clampVolume(volume: number) {
  if (Number.isNaN(volume)) return 1
  if (volume < 0) return 0
  if (volume > 1) return 1
  return volume
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

export const useAudioStore = create<AudioState>()(
  persist(
    (set) => ({
      volume: 1,
      playbackQuality: 'AUTO',
      setVolume: (volume) => set({ volume: clampVolume(volume) }),
      setPlaybackQuality: (quality) =>
        set({ playbackQuality: normalizePlaybackQuality(quality) }),
    }),
    {
      name: 'audio',
      partialize: (state) => ({
        volume: state.volume,
        playbackQuality: state.playbackQuality,
      }),
    },
  ),
)
