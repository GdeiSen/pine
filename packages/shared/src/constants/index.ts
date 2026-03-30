export const STATION_CODE_LENGTH = 6
export const STATION_CODE_CHARS = '0123456789'

export const MAX_FILE_SIZE_MB = 200
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024
export const USER_STORAGE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024

export const SUPPORTED_AUDIO_FORMATS = [
  'audio/mpeg',        // mp3
  'audio/mp3',         // mp3 (alias)
  'audio/x-mp3',       // mp3 (legacy alias)
  'audio/mpeg3',       // mp3 (legacy alias)
  'audio/flac',        // flac
  'audio/x-flac',      // flac (alias)
  'audio/wav',         // wav
  'audio/wave',        // wav (alias)
  'audio/vnd.wave',    // wav (alias)
  'audio/x-wav',       // wav
  'audio/aac',         // aac
  'audio/x-aac',       // aac (alias)
  'audio/ogg',         // ogg
  'application/ogg',   // ogg (alias)
  'audio/opus',        // opus
  'audio/mp4',         // m4a
  'audio/x-m4a',       // m4a
]

export const SUPPORTED_EXTENSIONS = ['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a']

export const PLAYBACK_SYNC_INTERVAL_MS = 5_000
export const HEARTBEAT_INTERVAL_MS = 30_000
export const SYNC_THRESHOLD_SECONDS = 2

export const QUALITY_BITRATES = {
  LOW: 64,
  MEDIUM: 128,
  HIGH: 320,
} as const

export const CHAT_PAGE_SIZE = 50
export const HISTORY_MAX_SIZE = 50

export const WS_EVENTS_V2 = {
  // Server → Client
  STATION_STATE: 'station:state:v2',
  TRACK_CHANGED: 'track:changed:v2',
  QUEUE_UPDATED: 'queue:updated:v2',
  PLAYBACK_SYNC: 'playback:sync:v2',
  LISTENER_JOINED: 'listener:joined:v2',
  LISTENER_LEFT: 'listener:left:v2',
  CHAT_MESSAGE: 'chat:message:v2',

  // Client → Server
  STATION_JOIN: 'station:join:v2',
  STATION_LEAVE: 'station:leave:v2',
  TIME_SYNC: 'time:sync:v2',
  CHAT_SEND: 'chat:send:v2',
  HEARTBEAT: 'station:heartbeat:v2',
} as const
