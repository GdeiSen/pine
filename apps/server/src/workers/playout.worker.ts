/* eslint-disable no-console */
import { createHash } from 'crypto'
import * as net from 'net'
import * as path from 'path'
import * as fs from 'fs/promises'
import {
  PlaybackCommandStatus,
  PlaybackCommandType,
  PlaybackEventType,
  PlaybackLoopMode,
  PrismaClient,
  QueueItemStatus,
  QueueType,
} from '@prisma/client'
import {
  createMinioClientFromEnv,
  resolveBucketByScope,
  resolveStorageBucketsFromEnv,
} from '../modules/storage/storage.config'

const prisma = new PrismaClient()
const minioClient = createMinioClientFromEnv()
const storageBuckets = resolveStorageBucketsFromEnv()
const tracksBucket = resolveBucketByScope('tracks', storageBuckets)

const POLL_INTERVAL_MS = Number.parseInt(process.env.PLAYOUT_POLL_INTERVAL_MS ?? '500', 10)
const HEARTBEAT_INTERVAL_MS = Number.parseInt(process.env.PLAYOUT_HEARTBEAT_INTERVAL_MS ?? '30000', 10)
const RECONCILE_INTERVAL_MS = Number.parseInt(
  process.env.PLAYOUT_RECONCILE_INTERVAL_MS ?? '5000',
  10,
)
const LIQUIDSOAP_CONTROL_DIR = process.env.LIQUIDSOAP_CONTROL_DIR ?? '/var/lib/liquidsoap/control'
const LIQUIDSOAP_CACHE_DIR = process.env.LIQUIDSOAP_CACHE_DIR ?? '/var/lib/liquidsoap/cache'
const LIQUIDSOAP_TELNET_HOST = process.env.LIQUIDSOAP_TELNET_HOST ?? 'liquidsoap'
const LIQUIDSOAP_TELNET_PORT = Number.parseInt(process.env.LIQUIDSOAP_TELNET_PORT ?? '1234', 10)
const LIQUIDSOAP_SOURCE_ID = (process.env.LIQUIDSOAP_SOURCE_ID ?? 'radio').trim() || 'radio'
const CONTROL_PLAYLIST_FILE = path.join(LIQUIDSOAP_CONTROL_DIR, 'playlist.m3u')
const CONTROL_STATE_FILE = path.join(LIQUIDSOAP_CONTROL_DIR, 'state.json')
const CONTROL_ACTIVE_STATION_FILE = path.join(LIQUIDSOAP_CONTROL_DIR, 'active-station.json')
const PLAYLIST_PREFETCH_LIMIT = Math.max(
  5,
  Number.parseInt(process.env.LIQUIDSOAP_PLAYLIST_PREFETCH_LIMIT ?? '100', 10),
)

const controlFingerprints = new Map<string, string>()
const controlInFlight = new Set<string>()

type CommandPayload = Record<string, unknown>

type LiquidsoapAction = 'skip'

type TrackRow = {
  id: string
  stationId: string
  originalPath: string
  filename: string
  title: string | null
  artist: string | null
  duration: number
}

type QueueSnapshotItem = {
  id: string
  stationId: string
  track: {
    id: string
    title: string | null
    artist: string | null
    album: string | null
    duration: number
    hasCover: boolean
    quality: string
    uploadedBy: {
      id: string
      username: string
      avatar: string | null
    }
  }
  addedBy: {
    id: string
    username: string
    avatar: string | null
  } | null
  queueType: QueueType
  position: number
  status: QueueItemStatus
}

function nowIso() {
  return new Date().toISOString()
}

function safeMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function asObject(payload: unknown): CommandPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {}
  return payload as CommandPayload
}

function normalizeLoopMode(value: unknown): PlaybackLoopMode | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === 'none') return PlaybackLoopMode.NONE
  if (raw === 'track') return PlaybackLoopMode.TRACK
  if (raw === 'queue') return PlaybackLoopMode.QUEUE
  return null
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0') return false
  }
  return null
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function currentPositionFromState(state: {
  isPaused: boolean
  pausedPosition: number
  currentPosition: number
  trackStartedAt: Date | null
  currentTrackDuration: number
}) {
  const base =
    state.isPaused || !state.trackStartedAt
      ? (state.pausedPosition || state.currentPosition || 0)
      : (Date.now() - state.trackStartedAt.getTime()) / 1000

  const duration = Math.max(0, state.currentTrackDuration || 0)
  if (!Number.isFinite(base)) return 0
  if (!duration) return Math.max(0, base)
  return clamp(base, 0, duration)
}

async function ensureDirectory(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

async function writeAtomic(filePath: string, content: string) {
  await ensureDirectory(path.dirname(filePath))
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tempPath, content, 'utf8')
  await fs.rename(tempPath, filePath)
}

async function recoverStuckCommands() {
  const staleBefore = new Date(Date.now() - 5 * 60_000)
  const recovered = await prisma.playbackCommand.updateMany({
    where: {
      status: PlaybackCommandStatus.PROCESSING,
      updatedAt: { lt: staleBefore },
    },
    data: { status: PlaybackCommandStatus.PENDING },
  })

  if (recovered.count > 0) {
    console.log(`[${nowIso()}] recovered stale commands: ${recovered.count}`)
  }
}

async function claimNextCommand() {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM playback_commands
      WHERE status = ${PlaybackCommandStatus.PENDING}::"playback_command_status"
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `

    if (rows.length === 0) return null

    const claimed = await tx.playbackCommand.update({
      where: { id: rows[0].id },
      data: { status: PlaybackCommandStatus.PROCESSING },
    })

    return claimed
  })
}

async function writeRejected(commandId: string, stationId: string, message: string) {
  await prisma.$transaction(async (tx) => {
    await tx.playbackCommand.update({
      where: { id: commandId },
      data: {
        status: PlaybackCommandStatus.REJECTED,
        rejectedAt: new Date(),
        errorMessage: message.slice(0, 1000),
      },
    })

    await tx.playbackEvent.create({
      data: {
        stationId,
        type: PlaybackEventType.COMMAND_REJECTED,
        commandId,
        payload: {
          error: message,
        },
      },
    })
  })
}

async function loadOrCreateState(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  stationId: string,
) {
  const station = await tx.station.findUnique({
    where: { id: stationId },
    select: {
      id: true,
      systemQueueMode: true,
    },
  })

  if (!station) {
    throw new Error('Station not found')
  }

  return tx.playbackState.upsert({
    where: { stationId },
    create: {
      stationId,
      currentTrackId: null,
      currentQueueItemId: null,
      currentQueueType: null,
      currentPosition: 0,
      currentTrackDuration: 0,
      trackStartedAt: null,
      isPaused: true,
      pausedPosition: 0,
      loopMode: PlaybackLoopMode.NONE,
      shuffleEnabled: station.systemQueueMode !== 'SEQUENTIAL',
      lastSyncedAt: new Date(),
    },
    update: {
      shuffleEnabled: station.systemQueueMode !== 'SEQUENTIAL',
    },
  })
}

async function resolveNextQueueItem(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  stationId: string,
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const userItem = await tx.queueItem.findFirst({
      where: {
        stationId,
        queueType: QueueType.USER,
        status: QueueItemStatus.PENDING,
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: {
        track: { select: { id: true, duration: true } },
      },
    })

    if (userItem?.track) return userItem
    if (userItem && !userItem.track) {
      await tx.queueItem.deleteMany({ where: { id: userItem.id } })
      continue
    }

    const systemItem = await tx.queueItem.findFirst({
      where: {
        stationId,
        queueType: QueueType.SYSTEM,
        status: QueueItemStatus.PENDING,
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: {
        track: { select: { id: true, duration: true } },
      },
    })

    if (systemItem?.track) return systemItem
    if (systemItem && !systemItem.track) {
      await tx.queueItem.deleteMany({ where: { id: systemItem.id } })
      continue
    }

    const rebuilt = await rebuildSystemQueueIfEmptyTx(tx, stationId)
    if (!rebuilt) return null
  }

  return null
}

async function resolvePreviousQueueItem(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  stationId: string,
  preferredQueueType?: QueueType | null,
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const baseWhere = {
      stationId,
      status: { in: [QueueItemStatus.PLAYED, QueueItemStatus.SKIPPED] as QueueItemStatus[] },
    }

    const previousItem =
      (preferredQueueType
        ? await tx.queueItem.findFirst({
            where: { ...baseWhere, queueType: preferredQueueType },
            orderBy: [{ playedAt: 'desc' }, { createdAt: 'desc' }, { position: 'desc' }],
            include: {
              track: { select: { id: true, duration: true } },
            },
          })
        : null) ??
      (await tx.queueItem.findFirst({
        where: baseWhere,
        orderBy: [{ playedAt: 'desc' }, { createdAt: 'desc' }, { position: 'desc' }],
        include: {
          track: { select: { id: true, duration: true } },
        },
      }))

    if (previousItem?.track) return previousItem
    if (previousItem && !previousItem.track) {
      await tx.queueItem.deleteMany({ where: { id: previousItem.id } })
      continue
    }

    return null
  }

  return null
}

function shuffleArray<T>(input: T[]) {
  const copy = [...input]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

async function rebuildSystemQueueIfEmptyTx(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  stationId: string,
) {
  const pendingSystemCount = await tx.queueItem.count({
    where: {
      stationId,
      queueType: QueueType.SYSTEM,
      status: QueueItemStatus.PENDING,
    },
  })
  if (pendingSystemCount > 0) return false

  const station = await tx.station.findUnique({
    where: { id: stationId },
    select: {
      activePlaylistId: true,
      systemQueueMode: true,
    },
  })
  if (!station) return false

  let activePlaylistId = station.activePlaylistId
  if (!activePlaylistId) {
    const fallbackPlaylist = await tx.playlist.findFirst({
      where: { stationId },
      select: { id: true },
      orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    })
    if (!fallbackPlaylist?.id) return false
    activePlaylistId = fallbackPlaylist.id
    await tx.station.update({
      where: { id: stationId },
      data: { activePlaylistId },
    })
  }

  const playlistTracks = await tx.playlistTrack.findMany({
    where: { playlistId: activePlaylistId },
    select: { trackId: true, sortOrder: true },
    orderBy: [{ sortOrder: 'asc' }, { addedAt: 'asc' }],
  })

  let trackIds = playlistTracks
    .map((entry) => entry.trackId)
    .filter((trackId): trackId is string => typeof trackId === 'string' && trackId.length > 0)

  if (trackIds.length === 0) return false

  if (station.systemQueueMode === 'SHUFFLE' || station.systemQueueMode === 'SMART_SHUFFLE') {
    trackIds = shuffleArray(trackIds)
  }

  await tx.queueItem.createMany({
    data: trackIds.map((trackId, index) => ({
      stationId,
      trackId,
      queueType: QueueType.SYSTEM,
      status: QueueItemStatus.PENDING,
      position: index,
    })),
  })

  return true
}

async function sendLiquidsoapRawCommand(command: string, options?: { tolerateUnknown?: boolean }) {

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let response = ''
    let sawEnd = false
    let wroteQuit = false
    const finish = (error?: Error | null) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }

    const socket = net.createConnection(
      { host: LIQUIDSOAP_TELNET_HOST, port: LIQUIDSOAP_TELNET_PORT },
      () => {
        socket.write(`${command}\n`, 'utf8', (writeError) => {
          if (writeError) {
            finish(writeError instanceof Error ? writeError : new Error(String(writeError)))
            socket.destroy()
          }
        })
      },
    )

    socket.setEncoding('utf8')
    socket.setTimeout(5000)
    socket.on('data', (chunk: string) => {
      response += chunk
      if (!sawEnd && /(^|\n)END(\r?\n|$)/.test(response)) {
        sawEnd = true
        if (!wroteQuit) {
          wroteQuit = true
          socket.write('quit\n')
        }
      }
    })
    socket.on('timeout', () => {
      finish(new Error(`Liquidsoap telnet command timed out: ${command}`))
      socket.destroy()
    })
    socket.on('error', (error) => {
      finish(error instanceof Error ? error : new Error(String(error)))
    })
    socket.on('close', () => {
      if (/ERROR:/i.test(response)) {
        if (options?.tolerateUnknown && /unknown/i.test(response)) {
          finish()
          return
        }
        finish(new Error(`Liquidsoap telnet command failed: ${command}; response=${response.trim()}`))
        return
      }
      if (!sawEnd && response.trim().length === 0) {
        finish(new Error(`Liquidsoap telnet command closed without response: ${command}`))
        return
      }
      finish()
    })
  })
}

async function sendLiquidsoapCommand(action: LiquidsoapAction) {
  const command = `${LIQUIDSOAP_SOURCE_ID}.${action}`
  await sendLiquidsoapRawCommand(command)
}

function sanitizePlaylistLabel(track: TrackRow) {
  const title = (track.title?.trim() || track.filename || track.id).replace(/[\r\n]+/g, ' ')
  const artist = track.artist?.trim()
  return artist ? `${title} - ${artist.replace(/[\r\n]+/g, ' ')}` : title
}

function formatQueueItemSnapshot(item: {
  id: string
  stationId: string
  track: {
    id: string
    title: string | null
    artist: string | null
    album: string | null
    duration: number
    coverPath: string | null
    quality: string
    uploadedBy: {
      id: string
      username: string
      avatar: string | null
    }
  }
  addedBy: {
    id: string
    username: string
    avatar: string | null
  } | null
  queueType: QueueType
  position: number
  status: QueueItemStatus
}): QueueSnapshotItem {
  return {
    id: item.id,
    stationId: item.stationId,
    track: {
      id: item.track.id,
      title: item.track.title,
      artist: item.track.artist,
      album: item.track.album,
      duration: item.track.duration,
      hasCover: !!item.track.coverPath,
      quality: item.track.quality,
      uploadedBy: item.track.uploadedBy,
    },
    addedBy: item.addedBy,
    queueType: item.queueType,
    position: item.position,
    status: item.status,
  }
}

async function ensureCachedTrack(track: TrackRow) {
  const extension = path.extname(track.originalPath) || path.extname(track.filename) || '.mp3'
  const stationCacheDir = path.join(LIQUIDSOAP_CACHE_DIR, track.stationId)
  const cachePath = path.join(stationCacheDir, `${track.id}${extension}`)

  try {
    const stat = await fs.stat(cachePath)
    if (stat.size > 0) return cachePath
  } catch {
    // cache miss, download below
  }

  await ensureDirectory(stationCacheDir)
  const tempPath = `${cachePath}.partial-${process.pid}-${Date.now()}`
  await minioClient.fGetObject(tracksBucket, track.originalPath, tempPath)
  await fs.rename(tempPath, cachePath)
  return cachePath
}

async function normalizePendingQueuePositionsTx(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  stationId: string,
  queueType: QueueType,
) {
  const pending = await tx.queueItem.findMany({
    where: { stationId, queueType, status: QueueItemStatus.PENDING },
    select: { id: true, position: true, createdAt: true },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })

  await Promise.all(
    pending.map((item, index) =>
      item.position === index
        ? Promise.resolve()
        : tx.queueItem.update({
            where: { id: item.id },
            data: { position: index },
          }),
    ),
  )
}

async function shiftPendingQueueRightTx(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  stationId: string,
  queueType: QueueType,
  fromPosition = 0,
) {
  const pending = await tx.queueItem.findMany({
    where: {
      stationId,
      queueType,
      status: QueueItemStatus.PENDING,
      position: { gte: fromPosition },
    },
    select: { id: true, position: true },
    orderBy: [{ position: 'desc' }, { id: 'desc' }],
  })

  for (const item of pending) {
    await tx.queueItem.update({
      where: { id: item.id },
      data: { position: item.position + 1 },
    })
  }
}

async function snapshotQueueTx(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  stationId: string,
) {
  const pending = await tx.queueItem.findMany({
    where: { stationId, status: QueueItemStatus.PENDING },
    include: {
      track: {
        include: {
          uploadedBy: { select: { id: true, username: true, avatar: true } },
        },
      },
      addedBy: { select: { id: true, username: true, avatar: true } },
    },
    orderBy: [{ queueType: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
  })

  return pending
    .filter((item) => !!item.track)
    .sort((a, b) => {
      if (a.queueType === b.queueType) return a.position - b.position
      return a.queueType === QueueType.USER ? -1 : 1
    })
    .map((item) => formatQueueItemSnapshot(item as never))
}

async function applyQueueAddCommand(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  stationId: string,
  payload: CommandPayload,
  addedById: string,
) {
  const trackId = typeof payload.trackId === 'string' ? payload.trackId : null
  if (!trackId) throw new Error('Invalid queue add payload: trackId is required')

  const mode = typeof payload.mode === 'string' ? payload.mode : 'end'
  const beforeItemId = typeof payload.beforeItemId === 'string' ? payload.beforeItemId : null

  const track = await tx.track.findUnique({
    where: { id: trackId },
    select: { id: true, stationId: true },
  })
  if (!track || track.stationId !== stationId) {
    throw new Error('Track not found in this station')
  }

  const pendingQueue = await tx.queueItem.findMany({
    where: { stationId, queueType: QueueType.USER, status: QueueItemStatus.PENDING },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, position: true },
  })

  const maxPosition = pendingQueue.at(-1)?.position ?? -1
  let insertPosition = maxPosition + 1

  if (beforeItemId) {
    const target = pendingQueue.find((queueItem) => queueItem.id === beforeItemId)
    if (target) {
      insertPosition = target.position
    }
  } else if (mode === 'next' || mode === 'now') {
    insertPosition = 0
  }

  if (insertPosition <= maxPosition) {
    await tx.queueItem.updateMany({
      where: {
        stationId,
        queueType: QueueType.USER,
        status: QueueItemStatus.PENDING,
        position: { gte: insertPosition },
      },
      data: { position: { increment: 1 } },
    })
  }

  await tx.queueItem.create({
    data: {
      stationId,
      trackId,
      addedById,
      queueType: QueueType.USER,
      position: insertPosition,
      status: QueueItemStatus.PENDING,
    },
  })

  await normalizePendingQueuePositionsTx(tx, stationId, QueueType.USER)
  return snapshotQueueTx(tx, stationId)
}

async function applyQueueRemoveCommand(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  stationId: string,
  payload: CommandPayload,
) {
  const itemId = typeof payload.itemId === 'string' ? payload.itemId : null
  if (!itemId) throw new Error('Invalid queue remove payload: itemId is required')

  const item = await tx.queueItem.findUnique({
    where: { id: itemId },
    select: { id: true, stationId: true, queueType: true, status: true },
  })
  if (!item || item.stationId !== stationId) {
    throw new Error('Queue item not found')
  }

  await tx.queueItem.delete({ where: { id: itemId } })

  if (item.status === QueueItemStatus.PENDING) {
    await normalizePendingQueuePositionsTx(tx, stationId, item.queueType)
  }

  return snapshotQueueTx(tx, stationId)
}

async function applyQueueReorderCommand(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  stationId: string,
  payload: CommandPayload,
) {
  const rawItems = Array.isArray(payload.items) ? payload.items : []
  const requested = rawItems
    .filter((item): item is { id: string; position: number } => !!item && typeof item === 'object')
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : '',
      position: typeof item.position === 'number' && Number.isFinite(item.position) ? item.position : 0,
    }))
    .filter((item) => item.id.length > 0)

  const uniqueIds = new Set(requested.map((item) => item.id))
  if (uniqueIds.size !== requested.length) {
    throw new Error('Duplicate queue item IDs in reorder payload')
  }

  const pending = await tx.queueItem.findMany({
    where: {
      stationId,
      queueType: QueueType.USER,
      status: QueueItemStatus.PENDING,
    },
    select: { id: true, position: true, createdAt: true },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  })

  if (pending.length === 0) {
    return snapshotQueueTx(tx, stationId)
  }

  const pendingIdSet = new Set(pending.map((item) => item.id))
  for (const item of requested) {
    if (!pendingIdSet.has(item.id)) {
      throw new Error(`Queue item ${item.id} not found in pending user queue`)
    }
  }

  const sortedRequestedIds = [...requested]
    .sort((a, b) => a.position - b.position)
    .map((item) => item.id)

  const remainingIds = pending
    .map((item) => item.id)
    .filter((id) => !uniqueIds.has(id))

  const nextOrder = [...sortedRequestedIds, ...remainingIds]
  await Promise.all(
    nextOrder.map((id, index) =>
      tx.queueItem.update({
        where: { id },
        data: { position: index },
      }),
    ),
  )

  await normalizePendingQueuePositionsTx(tx, stationId, QueueType.USER)
  return snapshotQueueTx(tx, stationId)
}

async function buildLiquidsoapSnapshot(stationId: string) {
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    select: { id: true, systemQueueMode: true },
  })
  if (!station) return null

  const playback = await prisma.playbackState.upsert({
    where: { stationId },
    create: {
      stationId,
      currentTrackId: null,
      currentQueueItemId: null,
      currentQueueType: null,
      currentPosition: 0,
      currentTrackDuration: 0,
      trackStartedAt: null,
      isPaused: true,
      pausedPosition: 0,
      loopMode: PlaybackLoopMode.NONE,
      shuffleEnabled: station.systemQueueMode !== 'SEQUENTIAL',
      lastSyncedAt: new Date(),
    },
    update: {
      shuffleEnabled: station.systemQueueMode !== 'SEQUENTIAL',
    },
  })

  const currentTrack = playback.currentTrackId
    ? await prisma.track.findUnique({
        where: { id: playback.currentTrackId },
        select: {
          id: true,
          stationId: true,
          originalPath: true,
          filename: true,
          title: true,
          artist: true,
          duration: true,
        },
      })
    : null

  const queueItems = await prisma.queueItem.findMany({
    where: {
      stationId,
      status: QueueItemStatus.PENDING,
    },
    include: {
      track: {
        select: {
          id: true,
          stationId: true,
          originalPath: true,
          filename: true,
          title: true,
          artist: true,
          duration: true,
        },
      },
    },
    orderBy: [{ queueType: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
  })

  const orderedQueueTracks = queueItems
    .filter((item) => !!item.track)
    .sort((a, b) => {
      if (a.queueType === b.queueType) return a.position - b.position
      return a.queueType === QueueType.USER ? -1 : 1
    })
    .map((item) => item.track as TrackRow)

  const trackById = new Map<string, TrackRow>()
  if (currentTrack) trackById.set(currentTrack.id, currentTrack)
  for (const track of orderedQueueTracks) {
    trackById.set(track.id, track)
  }

  const candidateTracks: TrackRow[] = []
  if (!playback.isPaused) {
    if (currentTrack) {
      candidateTracks.push(currentTrack)
    } else if (orderedQueueTracks[0]) {
      candidateTracks.push(orderedQueueTracks[0])
    }
  }

  for (const track of orderedQueueTracks) {
    if (!trackById.has(track.id)) continue
    if (candidateTracks.some((entry) => entry.id === track.id)) continue
    candidateTracks.push(track)
  }

  const limitedTracks = candidateTracks.slice(0, PLAYLIST_PREFETCH_LIMIT)

  const playableEntries: Array<TrackRow & { cachePath: string }> = []
  for (const track of limitedTracks) {
    try {
      const cachePath = await ensureCachedTrack(track)
      playableEntries.push({ ...track, cachePath })
    } catch (error) {
      console.warn(
        `[${nowIso()}] failed to cache track ${track.id} for station ${stationId}: ${safeMessage(error)}`,
      )
    }
  }

  // Keep the control playlist in the most compatible format for liquidsoap:
  // one absolute media path per line, without extended M3U metadata.
  const playlistLines = playableEntries.map((track) => track.cachePath)

  const playlistText = `${playlistLines.join('\n')}\n`
  const fingerprintSource = JSON.stringify({
    stationId,
    currentTrackId: playback.currentTrackId,
    currentQueueItemId: playback.currentQueueItemId,
    currentQueueType: playback.currentQueueType,
    currentPosition: playback.currentPosition,
    currentTrackDuration: playback.currentTrackDuration,
    isPaused: playback.isPaused,
    pausedPosition: playback.pausedPosition,
    trackStartedAt: playback.trackStartedAt?.toISOString() ?? null,
    loopMode: playback.loopMode,
    shuffleEnabled: playback.shuffleEnabled,
    tracks: playableEntries.map((track) => ({
      id: track.id,
      cachePath: track.cachePath,
      duration: track.duration,
    })),
  })
  const fingerprint = createHash('sha256').update(fingerprintSource).digest('hex')

  return {
    stationId,
    sourceId: LIQUIDSOAP_SOURCE_ID,
    fingerprint,
    playback: {
      stationId: playback.stationId,
      currentTrackId: playback.currentTrackId,
      currentQueueItemId: playback.currentQueueItemId,
      currentQueueType: playback.currentQueueType,
      currentPosition: playback.currentPosition,
      currentTrackDuration: playback.currentTrackDuration,
      trackStartedAt: playback.trackStartedAt?.toISOString() ?? null,
      isPaused: playback.isPaused,
      pausedPosition: playback.pausedPosition,
      loopMode: playback.loopMode,
      shuffleEnabled: playback.shuffleEnabled,
      version: playback.version,
      serverTime: nowIso(),
    },
    queue: playableEntries.map((track, index) => ({
      id: track.id,
      stationId: track.stationId,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
      filename: track.filename,
      cachePath: track.cachePath,
      order: index,
    })),
    playlistText,
  }
}

async function syncLiquidsoapStation(stationId: string, action?: LiquidsoapAction) {
  if (controlInFlight.has(stationId)) return
  controlInFlight.add(stationId)

  try {
    const snapshot = await buildLiquidsoapSnapshot(stationId)
    if (!snapshot) return

    const previousFingerprint = controlFingerprints.get(stationId)
    const changed = previousFingerprint !== snapshot.fingerprint

    await ensureDirectory(LIQUIDSOAP_CONTROL_DIR)
    await writeAtomic(CONTROL_PLAYLIST_FILE, snapshot.playlistText)
    await writeAtomic(CONTROL_STATE_FILE, `${JSON.stringify(snapshot, null, 2)}\n`)
    await writeAtomic(CONTROL_ACTIVE_STATION_FILE, `${JSON.stringify({ stationId, updatedAt: nowIso() }, null, 2)}\n`)
    controlFingerprints.set(stationId, snapshot.fingerprint)

    if (action === 'skip') {
      // Make sure playlist source picks up newly written playlist ordering
      // before we request immediate track transition.
      await sendLiquidsoapRawCommand(`${LIQUIDSOAP_SOURCE_ID}.reload`, { tolerateUnknown: true })
      await sendLiquidsoapCommand('skip')
    }
  } catch (error) {
    console.warn(`[${nowIso()}] liquidsoap sync failed for station ${stationId}: ${safeMessage(error)}`)
  } finally {
    controlInFlight.delete(stationId)
  }
}

async function markTrackPlaybackTransition(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  stationId: string,
  now: Date,
) {
  const state = await loadOrCreateState(tx, stationId)
  const currentPosition = currentPositionFromState(state)

  if (state.isPaused || !state.currentTrackId) {
    return { changed: false, state }
  }

  if (state.currentTrackDuration > 0 && currentPosition < Math.max(state.currentTrackDuration - 0.25, 0)) {
    return { changed: false, state }
  }

  if (state.currentQueueItemId) {
    await tx.queueItem.updateMany({
      where: {
        id: state.currentQueueItemId,
        status: QueueItemStatus.PLAYING,
      },
      data: {
        status: QueueItemStatus.PLAYED,
        playedAt: now,
      },
    })
  }

  const nextItem = await resolveNextQueueItem(tx, stationId)
  if (nextItem) {
    await tx.queueItem.update({
      where: { id: nextItem.id },
      data: { status: QueueItemStatus.PLAYING },
    })

    const nextState = await tx.playbackState.update({
      where: { stationId },
      data: {
        currentTrackId: nextItem.track.id,
        currentQueueItemId: nextItem.id,
        currentQueueType: nextItem.queueType,
        currentPosition: 0,
        currentTrackDuration: nextItem.track.duration || 0,
        trackStartedAt: now,
        isPaused: false,
        pausedPosition: 0,
        version: { increment: 1 },
        lastSyncedAt: now,
      },
    })

    await tx.playbackEvent.create({
      data: {
        stationId,
        type: PlaybackEventType.TRACK_CHANGED,
        payload: {
          autoAdvance: true,
          currentTrackId: nextState.currentTrackId,
          currentQueueItemId: nextState.currentQueueItemId,
          currentQueueType: nextState.currentQueueType,
          currentPosition: nextState.currentPosition,
          currentTrackDuration: nextState.currentTrackDuration,
          isPaused: nextState.isPaused,
          trackStartedAt: nextState.trackStartedAt?.toISOString() ?? null,
          serverTime: now.toISOString(),
        },
      },
    })

    return { changed: true, state: nextState }
  }

  const nextState = await tx.playbackState.update({
    where: { stationId },
    data: {
      currentTrackId: null,
      currentQueueItemId: null,
      currentQueueType: null,
      currentPosition: 0,
      currentTrackDuration: 0,
      trackStartedAt: null,
      isPaused: true,
      pausedPosition: 0,
      version: { increment: 1 },
      lastSyncedAt: now,
    },
  })

  await tx.playbackEvent.create({
    data: {
      stationId,
      type: PlaybackEventType.STATE_CHANGED,
      payload: {
        autoAdvance: true,
        currentTrackId: null,
        currentQueueItemId: null,
        currentQueueType: null,
        currentPosition: 0,
        currentTrackDuration: 0,
        isPaused: true,
        trackStartedAt: null,
        serverTime: now.toISOString(),
      },
    },
  })

  return { changed: true, state: nextState }
}

async function applyCommand(command: {
  id: string
  stationId: string
  type: PlaybackCommandType
  payload: unknown
  createdById: string | null
}) {
  const payload = asObject(command.payload)
  let mediaAction: LiquidsoapAction | undefined

  if (
    command.type === PlaybackCommandType.QUEUE_ADD ||
    command.type === PlaybackCommandType.QUEUE_REMOVE ||
    command.type === PlaybackCommandType.QUEUE_REORDER
  ) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${command.stationId}))`

      const now = new Date()
      const addedById = command.createdById
      if (command.type === PlaybackCommandType.QUEUE_ADD && !addedById) {
        throw new Error('Queue add command requires a creator')
      }
      const queue =
        command.type === PlaybackCommandType.QUEUE_ADD
          ? await applyQueueAddCommand(tx, command.stationId, payload, addedById ?? '')
          : command.type === PlaybackCommandType.QUEUE_REMOVE
            ? await applyQueueRemoveCommand(tx, command.stationId, payload)
            : await applyQueueReorderCommand(tx, command.stationId, payload)

      await tx.playbackCommand.update({
        where: { id: command.id },
        data: {
          status: PlaybackCommandStatus.ACKED,
          appliedAt: now,
          errorMessage: null,
        },
      })

      await tx.playbackEvent.create({
        data: {
          stationId: command.stationId,
          type: PlaybackEventType.QUEUE_UPDATED,
          commandId: command.id,
          payload: {
            queue,
            commandType: command.type,
            serverTime: now.toISOString(),
          },
        },
      })
    })

    return { mediaAction: undefined }
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${command.stationId}))`

    const state = await loadOrCreateState(tx, command.stationId)
    const now = new Date()
    const currentPosition = currentPositionFromState(state)

    let nextTrackId = state.currentTrackId
    let nextQueueItemId = state.currentQueueItemId
    let nextQueueType = state.currentQueueType
    let nextDuration = state.currentTrackDuration
    let nextPosition = state.currentPosition
    let nextPausedPosition = state.pausedPosition
    let nextTrackStartedAt = state.trackStartedAt
    let nextPaused = state.isPaused
    let nextLoopMode = state.loopMode
    let nextShuffleEnabled = state.shuffleEnabled
    let eventType: PlaybackEventType = PlaybackEventType.COMMAND_APPLIED

    if (command.type === PlaybackCommandType.PLAY) {
      nextPaused = false
      if (state.isPaused && nextTrackId) {
        nextPosition = currentPosition
        nextPausedPosition = currentPosition
        nextTrackStartedAt = new Date(now.getTime() - currentPosition * 1000)
      } else {
        nextPosition = currentPosition
        nextPausedPosition = currentPosition
        nextTrackStartedAt = new Date(now.getTime() - currentPosition * 1000)
      }

      if (!nextTrackId) {
        const nextItem = await resolveNextQueueItem(tx, command.stationId)
        if (nextItem) {
          await tx.queueItem.update({
            where: { id: nextItem.id },
            data: { status: QueueItemStatus.PLAYING },
          })

          nextTrackId = nextItem.track.id
          nextQueueItemId = nextItem.id
          nextQueueType = nextItem.queueType
          nextDuration = nextItem.track.duration || 0
          nextPosition = 0
          nextPausedPosition = 0
          nextTrackStartedAt = now
          eventType = PlaybackEventType.TRACK_CHANGED
          mediaAction = 'skip'
        }
      }
      if (!nextTrackId) {
        nextPaused = true
        nextPosition = 0
        nextPausedPosition = 0
        nextTrackStartedAt = null
      }
    } else if (command.type === PlaybackCommandType.PAUSE) {
      nextPaused = true
      nextPausedPosition = currentPosition
      nextPosition = currentPosition
      nextTrackStartedAt = null
    } else if (command.type === PlaybackCommandType.SEEK) {
      const requestedPosition = toNumber(payload.position)
      if (requestedPosition === null) {
        throw new Error('Invalid seek position payload')
      }
      const clampedPosition = clamp(
        requestedPosition,
        0,
        Math.max(nextDuration || currentPosition, 0),
      )

      nextPosition = clampedPosition
      nextPausedPosition = clampedPosition
      nextTrackStartedAt = nextPaused ? null : new Date(now.getTime() - clampedPosition * 1000)
    } else if (command.type === PlaybackCommandType.SET_LOOP) {
      const loopMode = normalizeLoopMode(payload.loopMode)
      if (!loopMode) {
        throw new Error('Invalid loop mode payload')
      }
      nextLoopMode = loopMode
    } else if (command.type === PlaybackCommandType.SET_SHUFFLE) {
      const shuffleEnabled = toBoolean(payload.shuffleEnabled)
      if (shuffleEnabled === null) {
        throw new Error('Invalid shuffle payload')
      }
      nextShuffleEnabled = shuffleEnabled
    } else if (command.type === PlaybackCommandType.SKIP) {
      if (nextQueueItemId) {
        await tx.queueItem.updateMany({
          where: { id: nextQueueItemId, status: QueueItemStatus.PLAYING },
          data: {
            status: QueueItemStatus.SKIPPED,
            playedAt: now,
          },
        })
      }

      const nextItem = await resolveNextQueueItem(tx, command.stationId)
      if (nextItem) {
        await tx.queueItem.update({
          where: { id: nextItem.id },
          data: { status: QueueItemStatus.PLAYING },
        })

        nextTrackId = nextItem.track.id
        nextQueueItemId = nextItem.id
        nextQueueType = nextItem.queueType
        nextDuration = nextItem.track.duration || 0
        nextPosition = 0
        nextPausedPosition = 0
        nextTrackStartedAt = now
        nextPaused = false
        eventType = PlaybackEventType.TRACK_CHANGED
        mediaAction = 'skip'
      } else {
        nextTrackId = null
        nextQueueItemId = null
        nextQueueType = null
        nextDuration = 0
        nextPosition = 0
        nextPausedPosition = 0
        nextTrackStartedAt = null
        nextPaused = true
        eventType = PlaybackEventType.STATE_CHANGED
      }
    } else if (command.type === PlaybackCommandType.PREVIOUS) {
      if (nextQueueItemId && nextQueueType) {
        await shiftPendingQueueRightTx(tx, command.stationId, nextQueueType, 0)

        await tx.queueItem.updateMany({
          where: { id: nextQueueItemId, status: QueueItemStatus.PLAYING },
          data: {
            status: QueueItemStatus.PENDING,
            position: 0,
            playedAt: null,
          },
        })

        await normalizePendingQueuePositionsTx(tx, command.stationId, nextQueueType)
      }

      const previousItem = await resolvePreviousQueueItem(tx, command.stationId, state.currentQueueType)
      if (previousItem) {
        await tx.queueItem.update({
          where: { id: previousItem.id },
          data: {
            status: QueueItemStatus.PLAYING,
            playedAt: null,
          },
        })

        nextTrackId = previousItem.track.id
        nextQueueItemId = previousItem.id
        nextQueueType = previousItem.queueType
        nextDuration = previousItem.track.duration || 0
        nextPosition = 0
        nextPausedPosition = 0
        nextTrackStartedAt = now
        nextPaused = false
        eventType = PlaybackEventType.TRACK_CHANGED
        mediaAction = 'skip'
      } else if (!nextTrackId) {
        const fallback = await resolveNextQueueItem(tx, command.stationId)
        if (fallback) {
          await tx.queueItem.update({
            where: { id: fallback.id },
            data: { status: QueueItemStatus.PLAYING },
          })

          nextTrackId = fallback.track.id
          nextQueueItemId = fallback.id
          nextQueueType = fallback.queueType
          nextDuration = fallback.track.duration || 0
          nextPosition = 0
          nextPausedPosition = 0
          nextTrackStartedAt = now
          nextPaused = false
          eventType = PlaybackEventType.TRACK_CHANGED
          mediaAction = 'skip'
        }
      }
    }

    const updatedState = await tx.playbackState.update({
      where: { stationId: command.stationId },
      data: {
        currentTrackId: nextTrackId,
        currentQueueItemId: nextQueueItemId,
        currentQueueType: nextQueueType,
        currentPosition: nextPosition,
        currentTrackDuration: nextDuration,
        trackStartedAt: nextTrackStartedAt,
        isPaused: nextPaused,
        pausedPosition: nextPausedPosition,
        loopMode: nextLoopMode,
        shuffleEnabled: nextShuffleEnabled,
        version: { increment: 1 },
        lastSyncedAt: now,
      },
    })

    await tx.playbackCommand.update({
      where: { id: command.id },
      data: {
        status: PlaybackCommandStatus.ACKED,
        appliedAt: now,
        errorMessage: null,
      },
    })

    const queueSnapshot = await snapshotQueueTx(tx, command.stationId)

    await tx.playbackEvent.create({
      data: {
        stationId: command.stationId,
        type: eventType,
        commandId: command.id,
        payload: {
          version: updatedState.version,
          currentTrackId: updatedState.currentTrackId,
          currentPosition: updatedState.currentPosition,
          currentTrackDuration: updatedState.currentTrackDuration,
          isPaused: updatedState.isPaused,
          trackStartedAt: updatedState.trackStartedAt?.toISOString() ?? null,
          loopMode: updatedState.loopMode,
          shuffleEnabled: updatedState.shuffleEnabled,
          serverTime: now.toISOString(),
          commandType: command.type,
          queue: queueSnapshot,
        },
      },
    })

    if (command.type === PlaybackCommandType.SET_LOOP) {
      mediaAction = undefined
    }
  })

  return { mediaAction }
}

async function reconcileEndedPlayback() {
  const activeStates = await prisma.playbackState.findMany({
    where: {
      currentTrackId: { not: null },
      isPaused: false,
    },
    select: {
      stationId: true,
      currentTrackId: true,
      currentQueueItemId: true,
      currentQueueType: true,
      currentPosition: true,
      currentTrackDuration: true,
      trackStartedAt: true,
      isPaused: true,
      pausedPosition: true,
      loopMode: true,
      shuffleEnabled: true,
      version: true,
    },
  })

  for (const state of activeStates) {
    const currentPosition = currentPositionFromState(state)
    if (state.currentTrackDuration > 0 && currentPosition < Math.max(state.currentTrackDuration - 0.25, 0)) {
      continue
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${state.stationId}))`
        const result = await markTrackPlaybackTransition(tx, state.stationId, new Date())
        if (!result.changed) return
      })
      await syncLiquidsoapStation(state.stationId)
    } catch (error) {
      console.warn(
        `[${nowIso()}] failed to reconcile playback for station ${state.stationId}: ${safeMessage(error)}`,
      )
    }
  }
}

let stopped = false
let commandPolling = false
let reconcilePolling = false

async function runCommandLoop() {
  if (commandPolling || stopped) return
  commandPolling = true
  try {
    let processed = 0
    while (processed < 20 && !stopped) {
      const claimed = await claimNextCommand()
      if (!claimed) break

      try {
        const result = await applyCommand({
          id: claimed.id,
          stationId: claimed.stationId,
          type: claimed.type,
          payload: claimed.payload,
          createdById: claimed.createdById,
        })
        if (result.mediaAction) {
          await syncLiquidsoapStation(claimed.stationId, result.mediaAction)
        } else {
          await syncLiquidsoapStation(claimed.stationId)
        }
      } catch (error) {
        const message = safeMessage(error)
        await writeRejected(claimed.id, claimed.stationId, message)
        console.error(`[${nowIso()}] command rejected ${claimed.id}: ${message}`)
      }

      processed += 1
    }
  } catch (error) {
    console.error(`[${nowIso()}] playout command loop error: ${safeMessage(error)}`)
  } finally {
    commandPolling = false
  }
}

async function runReconcileLoop() {
  if (reconcilePolling || stopped) return
  reconcilePolling = true
  try {
    await reconcileEndedPlayback()
  } catch (error) {
    console.error(`[${nowIso()}] playout reconcile loop error: ${safeMessage(error)}`)
  } finally {
    reconcilePolling = false
  }
}

async function shutdown() {
  if (stopped) return
  stopped = true
  console.log(`[${nowIso()}] playout-worker stopping`)
  try {
    await prisma.$disconnect()
  } finally {
    process.exit(0)
  }
}

async function bootstrap() {
  await prisma.$connect()
  await recoverStuckCommands()

  console.log(`[${nowIso()}] playout-worker started`)
  await ensureDirectory(LIQUIDSOAP_CONTROL_DIR)
  await ensureDirectory(LIQUIDSOAP_CACHE_DIR)

  setInterval(() => {
    void runCommandLoop()
  }, Math.max(POLL_INTERVAL_MS, 100))

  setInterval(() => {
    void runReconcileLoop()
  }, Math.max(RECONCILE_INTERVAL_MS, 1000))

  setInterval(() => {
    console.log(`[${nowIso()}] playout-worker heartbeat`)
  }, Math.max(HEARTBEAT_INTERVAL_MS, 5_000))

  await runCommandLoop()
  await runReconcileLoop()
}

process.on('SIGINT', () => {
  void shutdown()
})

process.on('SIGTERM', () => {
  void shutdown()
})

void bootstrap().catch(async (error) => {
  console.error(`[${nowIso()}] playout-worker bootstrap failed: ${safeMessage(error)}`)
  await prisma.$disconnect()
  process.exit(1)
})
