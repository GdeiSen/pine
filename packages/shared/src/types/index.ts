// ─── Enums ───────────────────────────────────────────────────────────────────

export enum StationAccessMode {
  PUBLIC = 'PUBLIC',
  PRIVATE = 'PRIVATE',
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

export enum StationPlaybackMode {
  DIRECT = 'DIRECT',
  BROADCAST = 'BROADCAST',
}

export enum PlaybackCommandType {
  PLAY = 'PLAY',
  PAUSE = 'PAUSE',
  PREVIOUS = 'PREVIOUS',
  SKIP = 'SKIP',
  SEEK = 'SEEK',
  SET_LOOP = 'SET_LOOP',
  SET_SHUFFLE = 'SET_SHUFFLE',
  QUEUE_ADD = 'QUEUE_ADD',
  QUEUE_REMOVE = 'QUEUE_REMOVE',
  QUEUE_REORDER = 'QUEUE_REORDER',
}

export enum PlaybackCommandStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  ACKED = 'ACKED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

export enum PlaybackEventType {
  STATE_SNAPSHOT = 'STATE_SNAPSHOT',
  STATE_CHANGED = 'STATE_CHANGED',
  TRACK_CHANGED = 'TRACK_CHANGED',
  COMMAND_RECEIVED = 'COMMAND_RECEIVED',
  COMMAND_APPLIED = 'COMMAND_APPLIED',
  COMMAND_REJECTED = 'COMMAND_REJECTED',
  QUEUE_UPDATED = 'QUEUE_UPDATED',
  SYNC_TICK = 'SYNC_TICK',
  DRIFT_CORRECTED = 'DRIFT_CORRECTED',
  HEARTBEAT = 'HEARTBEAT',
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
  playbackMode: StationPlaybackMode
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

export interface WsPlaybackSync {
  currentTrackId: string | null
  position: number
  isPaused: boolean
  trackStartedAt: number | null
  currentQueueType?: QueueType | null
  loopMode?: 'none' | 'track' | 'queue'
  shuffleEnabled?: boolean
  serverTime?: number
  syncType?: 'heartbeat' | 'control' | 'track_changed'
}

export interface PlaybackCommand {
  id: string
  stationId: string
  type: PlaybackCommandType
  status: PlaybackCommandStatus
  payload: Record<string, unknown> | null
  createdById: string | null
  correlationId: string | null
  appliedAt: string | null
  rejectedAt: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export interface PlaybackEvent {
  id: string
  stationId: string
  type: PlaybackEventType
  payload: Record<string, unknown> | null
  commandId: string | null
  createdAt: string
  processedAt: string | null
}

export interface WsChatSend {
  content: string
}
