/* eslint-disable no-console */
import {
  PlaybackCommandStatus,
  PlaybackCommandType,
  PlaybackEventType,
  PlaybackLoopMode,
  PrismaClient,
  QueueItemStatus,
  QueueType,
} from '@prisma/client'

const prisma = new PrismaClient()

const POLL_INTERVAL_MS = Number.parseInt(
  process.env.PLAYBACK_POLL_INTERVAL_MS ?? process.env.PLAYOUT_POLL_INTERVAL_MS ?? '100',
  10,
)
const COMMAND_POLLING_ENABLED = process.env.PLAYBACK_COMMAND_POLLING_ENABLED === '1'
const HEARTBEAT_INTERVAL_MS = Number.parseInt(
  process.env.PLAYBACK_HEARTBEAT_INTERVAL_MS ?? process.env.PLAYOUT_HEARTBEAT_INTERVAL_MS ?? '30000',
  10,
)
const RECONCILE_INTERVAL_MS = Number.parseInt(
  process.env.PLAYBACK_RECONCILE_INTERVAL_MS ?? process.env.PLAYOUT_RECONCILE_INTERVAL_MS ?? '5000',
  10,
)
const STUCK_COMMAND_TTL_MS = Math.max(
  10_000,
  Number.parseInt(process.env.PLAYBACK_STUCK_COMMAND_TTL_MS ?? '60000', 10),
)
const STUCK_COMMAND_RECOVERY_INTERVAL_MS = Math.max(
  10_000,
  Number.parseInt(process.env.PLAYBACK_STUCK_COMMAND_RECOVERY_INTERVAL_MS ?? '30000', 10),
)

type CommandPayload = Record<string, unknown>

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

async function recoverStuckCommands() {
  const staleBefore = new Date(Date.now() - STUCK_COMMAND_TTL_MS)
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

async function expireLegacyQueuedCommands() {
  const expired = await prisma.playbackCommand.updateMany({
    where: {
      status: {
        in: [PlaybackCommandStatus.PENDING, PlaybackCommandStatus.PROCESSING],
      },
    },
    data: {
      status: PlaybackCommandStatus.EXPIRED,
      errorMessage: 'Expired after migration to synchronous command application path',
    },
  })

  if (expired.count > 0) {
    console.log(`[${nowIso()}] expired legacy queued commands: ${expired.count}`)
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
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const previousItem = await tx.queueItem.findFirst({
      where: {
        stationId,
        status: { in: [QueueItemStatus.PLAYED, QueueItemStatus.SKIPPED] as QueueItemStatus[] },
      },
      orderBy: [{ playedAt: 'desc' }, { createdAt: 'desc' }, { position: 'desc' }],
      include: {
        track: { select: { id: true, duration: true } },
      },
    })

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
}) {
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

async function applyQueuePlayNowTransition(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  stationId: string,
  commandId: string,
  now: Date,
) {
  const state = await loadOrCreateState(tx, stationId)
  const nextItem = await resolveNextQueueItem(tx, stationId)
  if (!nextItem) return false

  if (state.currentQueueItemId) {
    await tx.queueItem.updateMany({
      where: { id: state.currentQueueItemId, status: QueueItemStatus.PLAYING },
      data: {
        status: QueueItemStatus.SKIPPED,
        playedAt: now,
      },
    })
  }

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
      commandId,
      payload: {
        version: nextState.version,
        currentTrackId: nextState.currentTrackId,
        currentQueueItemId: nextState.currentQueueItemId,
        currentQueueType: nextState.currentQueueType,
        currentPosition: nextState.currentPosition,
        currentTrackDuration: nextState.currentTrackDuration,
        isPaused: nextState.isPaused,
        trackStartedAt: nextState.trackStartedAt?.toISOString() ?? null,
        loopMode: nextState.loopMode,
        shuffleEnabled: nextState.shuffleEnabled,
        serverTime: now.toISOString(),
        commandType: PlaybackCommandType.QUEUE_ADD,
        sourceType: 'queue-now',
      },
    },
  })

  return true
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

  if (state.loopMode === PlaybackLoopMode.TRACK) {
    const repeatedState = await tx.playbackState.update({
      where: { stationId },
      data: {
        currentPosition: 0,
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
          version: repeatedState.version,
          autoAdvance: true,
          currentTrackId: repeatedState.currentTrackId,
          currentQueueItemId: repeatedState.currentQueueItemId,
          currentQueueType: repeatedState.currentQueueType,
          currentPosition: repeatedState.currentPosition,
          currentTrackDuration: repeatedState.currentTrackDuration,
          isPaused: repeatedState.isPaused,
          trackStartedAt: repeatedState.trackStartedAt?.toISOString() ?? null,
          loopMode: repeatedState.loopMode,
          shuffleEnabled: repeatedState.shuffleEnabled,
          serverTime: now.toISOString(),
        },
      },
    })

    return { changed: true, state: repeatedState }
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
          version: nextState.version,
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
        version: nextState.version,
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

  if (
    command.type === PlaybackCommandType.QUEUE_ADD ||
    command.type === PlaybackCommandType.QUEUE_REMOVE ||
    command.type === PlaybackCommandType.QUEUE_REORDER
  ) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${command.stationId}))`

      const now = new Date()
      const addedById = command.createdById
      const queueAddMode =
        command.type === PlaybackCommandType.QUEUE_ADD && typeof payload.mode === 'string'
          ? payload.mode
          : 'end'
      if (command.type === PlaybackCommandType.QUEUE_ADD && !addedById) {
        throw new Error('Queue add command requires a creator')
      }
      if (command.type === PlaybackCommandType.QUEUE_ADD) {
        await applyQueueAddCommand(tx, command.stationId, payload, addedById ?? '')
      } else if (command.type === PlaybackCommandType.QUEUE_REMOVE) {
        await applyQueueRemoveCommand(tx, command.stationId, payload)
      } else {
        await applyQueueReorderCommand(tx, command.stationId, payload)
      }

      if (command.type === PlaybackCommandType.QUEUE_ADD && queueAddMode === 'now') {
        await applyQueuePlayNowTransition(tx, command.stationId, command.id, now)
      }

      const queue = await snapshotQueueTx(tx, command.stationId)

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

    return
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
      if (nextLoopMode === PlaybackLoopMode.TRACK && nextTrackId) {
        nextPosition = 0
        nextPausedPosition = 0
        nextTrackStartedAt = now
        nextPaused = false
        eventType = PlaybackEventType.TRACK_CHANGED
      } else {
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
      }
    } else if (command.type === PlaybackCommandType.PREVIOUS) {
      const currentItemId = nextQueueItemId
      const currentTrackId = nextTrackId
      const currentQueueType = nextQueueType
      const currentDuration = nextDuration

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

      const previousItem = await resolvePreviousQueueItem(tx, command.stationId)
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
      } else if (currentItemId && currentTrackId && currentQueueType) {
        await tx.queueItem.updateMany({
          where: { id: currentItemId, status: QueueItemStatus.PENDING },
          data: {
            status: QueueItemStatus.PLAYING,
            playedAt: null,
          },
        })

        nextTrackId = currentTrackId
        nextQueueItemId = currentItemId
        nextQueueType = currentQueueType
        nextDuration = currentDuration
        nextPosition = 0
        nextPausedPosition = 0
        nextTrackStartedAt = now
        nextPaused = false
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

  })
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
        await applyCommand({
          id: claimed.id,
          stationId: claimed.stationId,
          type: claimed.type,
          payload: claimed.payload,
          createdById: claimed.createdById,
        })
      } catch (error) {
        const message = safeMessage(error)
        await writeRejected(claimed.id, claimed.stationId, message)
        console.error(`[${nowIso()}] command rejected ${claimed.id}: ${message}`)
      }

      processed += 1
    }
  } catch (error) {
    console.error(`[${nowIso()}] playback command loop error: ${safeMessage(error)}`)
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
    console.error(`[${nowIso()}] playback reconcile loop error: ${safeMessage(error)}`)
  } finally {
    reconcilePolling = false
  }
}

async function shutdown() {
  if (stopped) return
  stopped = true
  console.log(`[${nowIso()}] playback-worker stopping`)
  try {
    await prisma.$disconnect()
  } finally {
    process.exit(0)
  }
}

async function bootstrap() {
  await prisma.$connect()

  console.log(
    `[${nowIso()}] playback-worker started (commandPolling=${COMMAND_POLLING_ENABLED ? 'enabled' : 'disabled'})`,
  )

  if (COMMAND_POLLING_ENABLED) {
    await recoverStuckCommands()
    setInterval(() => {
      void runCommandLoop()
    }, Math.max(POLL_INTERVAL_MS, 100))

    setInterval(() => {
      void recoverStuckCommands().catch((error) => {
        console.error(`[${nowIso()}] stuck command recovery error: ${safeMessage(error)}`)
      })
    }, STUCK_COMMAND_RECOVERY_INTERVAL_MS)
  } else {
    await expireLegacyQueuedCommands()
  }

  setInterval(() => {
    void runReconcileLoop()
  }, Math.max(RECONCILE_INTERVAL_MS, 1000))

  setInterval(() => {
    console.log(`[${nowIso()}] playback-worker heartbeat`)
  }, Math.max(HEARTBEAT_INTERVAL_MS, 5_000))

  if (COMMAND_POLLING_ENABLED) {
    await runCommandLoop()
  }
  await runReconcileLoop()
}

process.on('SIGINT', () => {
  void shutdown()
})

process.on('SIGTERM', () => {
  void shutdown()
})

void bootstrap().catch(async (error) => {
  console.error(`[${nowIso()}] playback-worker bootstrap failed: ${safeMessage(error)}`)
  await prisma.$disconnect()
  process.exit(1)
})
