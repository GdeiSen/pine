import { create } from 'zustand'
import type { QueueItem, ChatMessage, StationMember } from '@web-radio/shared'

export type LoopMode = 'none' | 'track' | 'queue'
export type AudioConnectionState =
  | 'idle'
  | 'connecting'
  | 'buffering'
  | 'reconnecting'
  | 'playing'
  | 'paused'
  | 'blocked'

export interface AudioDiagnostics {
  driftMs: number | null
  targetPosition: number | null
  actualPosition: number | null
  syncType: string | null
  rttMs: number | null
  updatedAt: number
}

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
  filename?: string | null
  bitrate?: number | null
  uploadedBy: { id: string; username: string; avatar: string | null }
}

interface StationInfo {
  id: string
  code: string
  name: string
  description: string | null
  coverImage: string | null
  previewVideos: string[]
  owner: { id: string; username: string; avatar: string | null }
  isLive: boolean
  accessMode: string
  isPasswordProtected: boolean
  crossfadeDuration: number
  playbackMode: 'DIRECT'
  activePlaylistId: string | null
  listenerCount: number
}

interface PlaybackState {
  version: number
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
  audioConnectionState: AudioConnectionState
  audioConnectionMessage: string | null
  audioDiagnostics: AudioDiagnostics | null
  queue: QueueItem[]
  members: StationMember[]
  chat: ChatMessage[]
  isConnected: boolean
  isConnecting: boolean

  setStation: (station: StationInfo) => void
  setPlayback: (playback: Partial<PlaybackState>) => void
  setAudioNeedsRestart: (value: boolean) => void
  setAudioConnection: (value: {
    state: AudioConnectionState
    message?: string | null
    diagnostics?: AudioDiagnostics | null
  }) => void
  setQueue: (queue: QueueItem[]) => void
  setMembers: (members: StationMember[]) => void
  addChatMessage: (message: ChatMessage) => void
  setChatMessages: (messages: ChatMessage[]) => void
  setConnected: (val: boolean) => void
  setConnecting: (val: boolean) => void
  reset: () => void
}

const initialPlayback: PlaybackState = {
  version: 0,
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
  audioConnectionState: 'idle',
  audioConnectionMessage: null,
  audioDiagnostics: null,
  queue: [],
  members: [],
  chat: [],
  isConnected: false,
  isConnecting: false,

  setStation: (station) => set({ station }),
  setPlayback: (playback) => set((s) => ({ playback: { ...s.playback, ...playback } })),
  setAudioNeedsRestart: (audioNeedsRestart) => set({ audioNeedsRestart }),
  setAudioConnection: ({ state, message = null, diagnostics = null }) =>
    set({
      audioConnectionState: state,
      audioConnectionMessage: message ?? null,
      audioDiagnostics: diagnostics,
      audioNeedsRestart: state === 'blocked',
    }),
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
      audioConnectionState: 'idle',
      audioConnectionMessage: null,
      audioDiagnostics: null,
      queue: [],
      members: [],
      chat: [],
      isConnected: false,
      isConnecting: false,
    }),
}))
