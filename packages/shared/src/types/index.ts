// ─── Enums ───────────────────────────────────────────────────────────────────

export enum StationAccessMode {
  PUBLIC = 'PUBLIC',
  PRIVATE = 'PRIVATE',
  // Legacy values kept for backward compatibility with old records.
  CODE_ONLY = 'CODE_ONLY',
  CODE_PASSWORD = 'CODE_PASSWORD',
}

export enum MemberRole {
  GUEST = 'GUEST',
  LISTENER = 'LISTENER',
  DJ = 'DJ',
  MODERATOR = 'MODERATOR',
  ADMIN = 'ADMIN',
  OWNER = 'OWNER',
}

export enum QueueType {
  USER = 'USER',
  SYSTEM = 'SYSTEM',
}

export enum QueueItemStatus {
  PENDING = 'PENDING',
  PLAYING = 'PLAYING',
  PLAYED = 'PLAYED',
  SKIPPED = 'SKIPPED',
}

export enum TrackQuality {
  LOW = 'LOW',       // 64kbps
  MEDIUM = 'MEDIUM', // 128kbps
  HIGH = 'HIGH',     // 320kbps
  LOSSLESS = 'LOSSLESS',
}

export enum StreamQuality {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

export enum TrackStatus {
  UPLOADING = 'UPLOADING',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  ERROR = 'ERROR',
}

export enum ChatMessageType {
  TEXT = 'TEXT',
  SYSTEM = 'SYSTEM',
  TRACK_ADDED = 'TRACK_ADDED',
  USER_JOINED = 'USER_JOINED',
  USER_LEFT = 'USER_LEFT',
}

export enum SystemQueueMode {
  SEQUENTIAL = 'SEQUENTIAL',
  SHUFFLE = 'SHUFFLE',
  SMART_SHUFFLE = 'SMART_SHUFFLE',
}

// ─── Permissions ─────────────────────────────────────────────────────────────

export enum Permission {
  PLAYBACK_CONTROL = 'PLAYBACK_CONTROL',
  SKIP_TRACK = 'SKIP_TRACK',
  ADD_TO_QUEUE = 'ADD_TO_QUEUE',
  REORDER_QUEUE = 'REORDER_QUEUE',
  REMOVE_FROM_QUEUE = 'REMOVE_FROM_QUEUE',
  UPLOAD_TRACKS = 'UPLOAD_TRACKS',
  DELETE_TRACKS = 'DELETE_TRACKS',
  MANAGE_PLAYLISTS = 'MANAGE_PLAYLISTS',
  MANAGE_MEMBERS = 'MANAGE_MEMBERS',
  CHANGE_STATION_SETTINGS = 'CHANGE_STATION_SETTINGS',
}

export const ROLE_PERMISSIONS: Record<MemberRole, Permission[]> = {
  [MemberRole.GUEST]: [],
  [MemberRole.LISTENER]: [],
  [MemberRole.DJ]: [
    Permission.ADD_TO_QUEUE,
    Permission.REORDER_QUEUE,
    Permission.UPLOAD_TRACKS,
  ],
  [MemberRole.MODERATOR]: [
    Permission.ADD_TO_QUEUE,
    Permission.REORDER_QUEUE,
    Permission.REMOVE_FROM_QUEUE,
    Permission.SKIP_TRACK,
    Permission.PLAYBACK_CONTROL,
    Permission.UPLOAD_TRACKS,
    Permission.DELETE_TRACKS,
  ],
  [MemberRole.ADMIN]: [
    Permission.ADD_TO_QUEUE,
    Permission.REORDER_QUEUE,
    Permission.REMOVE_FROM_QUEUE,
    Permission.SKIP_TRACK,
    Permission.PLAYBACK_CONTROL,
    Permission.UPLOAD_TRACKS,
    Permission.DELETE_TRACKS,
    Permission.MANAGE_PLAYLISTS,
    Permission.MANAGE_MEMBERS,
    Permission.CHANGE_STATION_SETTINGS,
  ],
  [MemberRole.OWNER]: Object.values(Permission),
}

// ─── Entities ────────────────────────────────────────────────────────────────

export interface User {
  id: string
  email: string
  username: string
  avatar: string | null
  createdAt: string
}

export interface Station {
  id: string
  code: string
  name: string
  description: string | null
  coverImage: string | null
  ownerId: string
  owner: Pick<User, 'id' | 'username' | 'avatar'>
  accessMode: StationAccessMode
  isPasswordProtected: boolean
  isLive: boolean
  currentTrack: TrackPublic | null
  currentPosition: number
  crossfadeDuration: number
  streamQuality: StreamQuality
  activePlaylistId: string | null
  listenerCount: number
  createdAt: string
}

export interface Playlist {
  id: string
  name: string
  stationId: string
  isDefault: boolean
  sortOrder: number
  coverImage: string | null
  trackCount: number
  totalDuration: number
  createdAt: string
}

export interface Track {
  id: string
  stationId: string
  playlistId: string | null
  uploadedById: string
  uploadedBy: Pick<User, 'id' | 'username' | 'avatar'>
  filename: string
  title: string | null
  artist: string | null
  album: string | null
  year: number | null
  genre: string | null
  duration: number
  fileSize: number
  bitrate: number | null
  quality: TrackQuality
  status: TrackStatus
  hasCover: boolean
  waveformData: number[] | null
  playCount: number
  createdAt: string
}

export type TrackPublic = Omit<Track, 'fileSize'>

export interface QueueItem {
  id: string
  stationId: string
  track: TrackPublic
  addedBy: Pick<User, 'id' | 'username' | 'avatar'> | null
  queueType: QueueType
  position: number
  status: QueueItemStatus
}

export interface StationMember {
  id: string
  stationId: string
  user: Pick<User, 'id' | 'username' | 'avatar'>
  role: MemberRole
  permissions: Permission[]
  joinedAt: string
  isOnline: boolean
}

export interface ChatMessage {
  id: string
  stationId: string
  user: Pick<User, 'id' | 'username' | 'avatar'> | null
  content: string
  type: ChatMessageType
  createdAt: string
}

// ─── Station State (WebSocket) ────────────────────────────────────────────────

export interface StationState {
  station: Station
  currentTrack: TrackPublic | null
  currentPosition: number
  isPaused: boolean
  trackStartedAt: number | null
  queue: QueueItem[]
  members: StationMember[]
  activePlaylist: Playlist | null
  systemQueueMode: SystemQueueMode
}

// ─── WebSocket Events ─────────────────────────────────────────────────────────

export interface WsStationJoin {
  code: string
  password?: string
}

export interface WsPlaybackControl {
  action: 'play' | 'pause' | 'seek' | 'skip'
  position?: number
}

export interface WsQueueAdd {
  trackId: string
  mode?: 'end' | 'next' | 'now'
  beforeItemId?: string
}

export interface WsQueueReorder {
  items: Array<{ id: string; position: number }>
}

export interface WsQueueRemove {
  itemId: string
}

export interface WsPlaybackSync {
  currentTrackId: string | null
  position: number
  isPaused: boolean
  trackStartedAt: number | null
}

export interface WsTrackEnded {
  trackId?: string
}

export interface WsChatSend {
  content: string
}
