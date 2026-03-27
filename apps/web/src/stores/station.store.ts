import { create } from 'zustand'
import type { QueueItem, ChatMessage, StationMember } from '@web-radio/shared'

export type LoopMode = 'none' | 'track' | 'queue'

interface CurrentTrack {
  id: string
  title: string | null
  artist: string | null
  album: string | null
  year: number | null
  genre: string | null
  duration: number
  hasCover: boolean
  quality: string
  uploadedBy: { id: string; username: string; avatar: string | null }
}

interface StationInfo {
  id: string
  code: string
  name: string
  description: string | null
  coverImage: string | null
  owner: { id: string; username: string; avatar: string | null }
  isLive: boolean
  accessMode: string
  isPasswordProtected: boolean
  crossfadeDuration: number
  streamQuality: 'LOW' | 'MEDIUM' | 'HIGH'
  activePlaylistId: string | null
  listenerCount: number
}

interface PlaybackState {
  currentTrack: CurrentTrack | null
  currentQueueType: 'USER' | 'SYSTEM' | null
  currentPosition: number
  isPaused: boolean
  trackStartedAt: number | null
  isPlaying: boolean
  loopMode: LoopMode
  shuffleEnabled: boolean
}

interface StationState {
  station: StationInfo | null
  playback: PlaybackState
  audioNeedsRestart: boolean
  queue: QueueItem[]
  members: StationMember[]
  chat: ChatMessage[]
  isConnected: boolean
  isConnecting: boolean

  setStation: (station: StationInfo) => void
  setPlayback: (playback: Partial<PlaybackState>) => void
  setAudioNeedsRestart: (value: boolean) => void
  setQueue: (queue: QueueItem[]) => void
  setMembers: (members: StationMember[]) => void
  addChatMessage: (message: ChatMessage) => void
  setChatMessages: (messages: ChatMessage[]) => void
  setConnected: (val: boolean) => void
  setConnecting: (val: boolean) => void
  reset: () => void
}

const initialPlayback: PlaybackState = {
  currentTrack: null,
  currentQueueType: null,
  currentPosition: 0,
  isPaused: true,
  trackStartedAt: null,
  isPlaying: false,
  loopMode: 'none',
  shuffleEnabled: false,
}

export const useStationStore = create<StationState>((set) => ({
  station: null,
  playback: initialPlayback,
  audioNeedsRestart: false,
  queue: [],
  members: [],
  chat: [],
  isConnected: false,
  isConnecting: false,

  setStation: (station) => set({ station }),
  setPlayback: (playback) => set((s) => ({ playback: { ...s.playback, ...playback } })),
  setAudioNeedsRestart: (audioNeedsRestart) => set({ audioNeedsRestart }),
  setQueue: (queue) => set({ queue }),
  setMembers: (members) => set({ members }),
  addChatMessage: (message) =>
    set((s) => {
      if (s.chat.some((m) => m.id === message.id)) return s
      return { chat: [...s.chat.slice(-99), message] }
    }),
  setChatMessages: (messages) => set({ chat: messages }),
  setConnected: (isConnected) => set({ isConnected }),
  setConnecting: (isConnecting) => set({ isConnecting }),
  reset: () =>
    set({
      station: null,
      playback: initialPlayback,
      audioNeedsRestart: false,
      queue: [],
      members: [],
      chat: [],
      isConnected: false,
      isConnecting: false,
    }),
}))
