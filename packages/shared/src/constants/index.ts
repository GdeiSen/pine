export const STATION_CODE_LENGTH = 6
export const STATION_CODE_CHARS = '0123456789'

export const MAX_FILE_SIZE_MB = 200
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024
export const USER_STORAGE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024

export const SUPPORTED_AUDIO_FORMATS = [
  'audio/mpeg',        // mp3
  'audio/flac',        // flac
  'audio/wav',         // wav
  'audio/x-wav',       // wav
  'audio/aac',         // aac
  'audio/ogg',         // ogg
  'audio/mp4',         // m4a
  'audio/x-m4a',       // m4a
]

export const SUPPORTED_EXTENSIONS = ['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a']

export const PLAYBACK_SYNC_INTERVAL_MS = 30_000
export const HEARTBEAT_INTERVAL_MS = 30_000
export const SYNC_THRESHOLD_SECONDS = 2

export const QUALITY_BITRATES = {
  LOW: 64,
  MEDIUM: 128,
  HIGH: 320,
} as const

export const CHAT_PAGE_SIZE = 50
export const HISTORY_MAX_SIZE = 50

export const WS_EVENTS = {
  // Server → Client
  STATION_STATE: 'station:state',
  TRACK_CHANGED: 'track:changed',
  TRACK_ENDED: 'track:ended',
  QUEUE_UPDATED: 'queue:updated',
  PLAYBACK_SYNC: 'playback:sync',
  LISTENER_JOINED: 'listener:joined',
  LISTENER_LEFT: 'listener:left',
  MEMBER_UPDATED: 'member:updated',
  CHAT_MESSAGE: 'chat:message',
  STATION_SETTINGS: 'station:settings',
  ERROR: 'error',

  // Client → Server
  STATION_JOIN: 'station:join',
  STATION_LEAVE: 'station:leave',
  PLAYBACK_CONTROL: 'playback:control',
  QUEUE_ADD: 'queue:add',
  QUEUE_REORDER: 'queue:reorder',
  QUEUE_REMOVE: 'queue:remove',
  QUEUE_SKIP: 'queue:skip',
  CHAT_SEND: 'chat:send',
  HEARTBEAT: 'station:heartbeat',
} as const
