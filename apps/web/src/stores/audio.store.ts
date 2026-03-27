import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AudioState {
  volume: number
  setVolume: (volume: number) => void
}

function clampVolume(volume: number) {
  if (Number.isNaN(volume)) return 1
  if (volume < 0) return 0
  if (volume > 1) return 1
  return volume
}

export const useAudioStore = create<AudioState>()(
  persist(
    (set) => ({
      volume: 1,
      setVolume: (volume) => set({ volume: clampVolume(volume) }),
    }),
    {
      name: 'audio',
      partialize: (state) => ({ volume: state.volume }),
    },
  ),
)
