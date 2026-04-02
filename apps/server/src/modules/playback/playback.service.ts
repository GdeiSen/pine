import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common'
import {
  PlaybackCommandStatus,
  PlaybackCommandType,
  PlaybackEventType,
  PlaybackLoopMode,
  Prisma,
  PlaybackCommandType as PrismaPlaybackCommandType,
  QueueItemStatus,
  QueueType,
} from '@prisma/client'
import { PlaybackCommandType as SharedPlaybackCommandType } from '@web-radio/shared'
import { PrismaService } from '../../prisma/prisma.service'
import { CreatePlaybackCommandDto } from './dto/create-playback-command.dto'

type TxClient = Prisma.TransactionClient
type CommandPayload = Record<string, unknown>

@Injectable()
export class PlaybackService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueueCommand(stationId: string, dto: CreatePlaybackCommandDto, userId: string) {
    await this.assertStationMember(stationId, userId)

    const type = this.toPrismaCommandType(dto.type)
    if (this.isQueueCommand(type)) {
      return this.applyQueueCommand({
        stationId,
        type,
        payload: dto.payload,
        userId,
      })
    }

    return this.applyInteractiveCommand({
      stationId,
      type,
      payload: dto.payload,
      userId,
    })
  }

  async getPlaybackState(stationId: string, userId: string) {
    await this.assertStationMember(stationId, userId)
    return this.ensurePlaybackState(stationId)
  }

  private async applyQueueCommand(args: {
    stationId: string
    type: PlaybackCommandType
    payload: unknown
    userId: string
  }) {
    const payload = this.asObject(args.payload)

    const command = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.stationId}))`

      const now = new Date()
      const created = await tx.playbackCommand.create({
        data: {
          stationId: args.stationId,
          type: args.type,
          payload: this.toPrismaPayload(args.payload),
          createdById: args.userId,
          status: PlaybackCommandStatus.PROCESSING,
        },
      })

      await tx.playbackEvent.create({
        data: {
          stationId: args.stationId,
          type: PlaybackEventType.COMMAND_RECEIVED,
          commandId: created.id,
          payload: this.toPrismaPayload({
            commandType: created.type,
            createdById: args.userId,
            serverTime: now.toISOString(),
          }),
        },
      })

      const queueAddMode =
        args.type === PlaybackCommandType.QUEUE_ADD && typeof payload.mode === 'string'
          ? payload.mode
          : 'end'

      if (args.type === PlaybackCommandType.QUEUE_ADD) {
        await this.applyQueueAddCommandTx(tx, args.stationId, payload, args.userId)
      } else if (args.type === PlaybackCommandType.QUEUE_REMOVE) {
        await this.applyQueueRemoveCommandTx(tx, args.stationId, payload)
      } else {
        await this.applyQueueReorderCommandTx(tx, args.stationId, payload)
      }

      if (args.type === PlaybackCommandType.QUEUE_ADD && queueAddMode === 'now') {
        await this.applyQueuePlayNowTransitionTx(tx, args.stationId, created.id, now)
      }

      const queue = await this.snapshotQueueTx(tx, args.stationId)

      await tx.playbackEvent.create({
        data: {
          stationId: args.stationId,
          type: PlaybackEventType.QUEUE_UPDATED,
          commandId: created.id,
          payload: this.toPrismaPayload({
            queue,
            commandType: args.type,
            serverTime: now.toISOString(),
          }),
        },
      })

      return tx.playbackCommand.update({
        where: { id: created.id },
        data: {
          status: PlaybackCommandStatus.ACKED,
          appliedAt: now,
          errorMessage: null,
        },
      })
    })

    return {
      queued: false,
      applied: true,
      command,
    }
  }

  private async applyInteractiveCommand(args: {
    stationId: string
    type: PlaybackCommandType
    payload: unknown
    userId: string
  }) {
    const payload = this.asObject(args.payload)

    const command = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.stationId}))`

      const now = new Date()
      const created = await tx.playbackCommand.create({
        data: {
          stationId: args.stationId,
          type: args.type,
          payload: this.toPrismaPayload(args.payload),
          createdById: args.userId,
          status: PlaybackCommandStatus.PROCESSING,
        },
      })

      await tx.playbackEvent.create({
        data: {
          stationId: args.stationId,
          type: PlaybackEventType.COMMAND_RECEIVED,
          commandId: created.id,
          payload: this.toPrismaPayload({
            commandType: created.type,
            createdById: args.userId,
            serverTime: now.toISOString(),
          }),
        },
      })

      const state = await this.loadOrCreateStateTx(tx, args.stationId)
      const currentPosition = this.currentPositionFromState(state)

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

      if (args.type === PlaybackCommandType.PLAY) {
        nextPaused = false
        nextPosition = currentPosition
        nextPausedPosition = currentPosition
        nextTrackStartedAt = new Date(now.getTime() - currentPosition * 1000)

        if (!nextTrackId) {
          const nextItem = await this.resolveNextQueueItemTx(tx, args.stationId)
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
      } else if (args.type === PlaybackCommandType.PAUSE) {
        nextPaused = true
        nextPausedPosition = currentPosition
        nextPosition = currentPosition
        nextTrackStartedAt = null
      } else if (args.type === PlaybackCommandType.SEEK) {
        const requestedPosition = this.toNumber(payload.position)
        if (requestedPosition === null) {
          throw new BadRequestException('Invalid seek position payload')
        }
        const clampedPosition = this.clamp(
          requestedPosition,
          0,
          Math.max(nextDuration || currentPosition, 0),
        )

        nextPosition = clampedPosition
        nextPausedPosition = clampedPosition
        nextTrackStartedAt = nextPaused ? null : new Date(now.getTime() - clampedPosition * 1000)
      } else if (args.type === PlaybackCommandType.SET_LOOP) {
        const loopMode = this.normalizeLoopMode(payload.loopMode)
        if (!loopMode) {
          throw new BadRequestException('Invalid loop mode payload')
        }
        nextLoopMode = loopMode
      } else if (args.type === PlaybackCommandType.SET_SHUFFLE) {
        const shuffleEnabled = this.toBoolean(payload.shuffleEnabled)
        if (shuffleEnabled === null) {
          throw new BadRequestException('Invalid shuffle payload')
        }
        nextShuffleEnabled = shuffleEnabled
      } else if (args.type === PlaybackCommandType.SKIP) {
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

          const nextItem = await this.resolveNextQueueItemTx(tx, args.stationId)
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
      } else if (args.type === PlaybackCommandType.PREVIOUS) {
        const currentItemId = nextQueueItemId
        const currentTrackId = nextTrackId
        const currentQueueType = nextQueueType
        const currentDuration = nextDuration

        if (nextQueueItemId && nextQueueType) {
          await this.shiftPendingQueueRightTx(tx, args.stationId, nextQueueType, 0)

          await tx.queueItem.updateMany({
            where: { id: nextQueueItemId, status: QueueItemStatus.PLAYING },
            data: {
              status: QueueItemStatus.PENDING,
              position: 0,
              playedAt: null,
            },
          })

          await this.normalizePendingQueuePositionsTx(tx, args.stationId, nextQueueType)
        }

        const previousItem = await this.resolvePreviousQueueItemTx(tx, args.stationId)
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
          const fallback = await this.resolveNextQueueItemTx(tx, args.stationId)
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
        where: { stationId: args.stationId },
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

      const queueSnapshot = await this.snapshotQueueTx(tx, args.stationId)

      await tx.playbackEvent.create({
        data: {
          stationId: args.stationId,
          type: eventType,
          commandId: created.id,
          payload: this.toPrismaPayload({
            version: updatedState.version,
            currentTrackId: updatedState.currentTrackId,
            currentQueueItemId: updatedState.currentQueueItemId,
            currentQueueType: updatedState.currentQueueType,
            currentPosition: updatedState.currentPosition,
            currentTrackDuration: updatedState.currentTrackDuration,
            isPaused: updatedState.isPaused,
            trackStartedAt: updatedState.trackStartedAt?.toISOString() ?? null,
            loopMode: updatedState.loopMode,
            shuffleEnabled: updatedState.shuffleEnabled,
            serverTime: now.toISOString(),
            commandType: args.type,
            queue: queueSnapshot,
          }),
        },
      })

      return tx.playbackCommand.update({
        where: { id: created.id },
        data: {
          status: PlaybackCommandStatus.ACKED,
          appliedAt: now,
          errorMessage: null,
        },
      })
    })

    return {
      queued: false,
      applied: true,
      command,
    }
  }

  private isQueueCommand(type: PlaybackCommandType) {
    return (
      type === PlaybackCommandType.QUEUE_ADD ||
      type === PlaybackCommandType.QUEUE_REMOVE ||
      type === PlaybackCommandType.QUEUE_REORDER
    )
  }

  private async ensurePlaybackState(stationId: string) {
    const station = await this.prisma.station.findUnique({
      where: { id: stationId },
      select: { id: true, systemQueueMode: true },
    })
    if (!station) throw new NotFoundException('Station not found')

    return this.prisma.playbackState.upsert({
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

  private async loadOrCreateStateTx(tx: TxClient, stationId: string) {
    const station = await tx.station.findUnique({
      where: { id: stationId },
      select: {
        id: true,
        systemQueueMode: true,
      },
    })

    if (!station) {
      throw new NotFoundException('Station not found')
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

  private async resolveNextQueueItemTx(tx: TxClient, stationId: string) {
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

      const rebuilt = await this.rebuildSystemQueueIfEmptyTx(tx, stationId)
      if (!rebuilt) return null
    }

    return null
  }

  private async resolvePreviousQueueItemTx(tx: TxClient, stationId: string) {
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

  private shuffleArray<T>(input: T[]) {
    const copy = [...input]
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
    }
    return copy
  }

  private async rebuildSystemQueueIfEmptyTx(tx: TxClient, stationId: string) {
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
      trackIds = this.shuffleArray(trackIds)
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

  private async normalizePendingQueuePositionsTx(
    tx: TxClient,
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

  private async shiftPendingQueueRightTx(
    tx: TxClient,
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

  private formatQueueItemSnapshot(item: {
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

  private async snapshotQueueTx(tx: TxClient, stationId: string) {
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
      .map((item) => this.formatQueueItemSnapshot(item as never))
  }

  private async applyQueueAddCommandTx(
    tx: TxClient,
    stationId: string,
    payload: CommandPayload,
    addedById: string,
  ) {
    const trackId = typeof payload.trackId === 'string' ? payload.trackId : null
    if (!trackId) throw new BadRequestException('Invalid queue add payload: trackId is required')

    const mode = typeof payload.mode === 'string' ? payload.mode : 'end'
    const beforeItemId = typeof payload.beforeItemId === 'string' ? payload.beforeItemId : null

    const track = await tx.track.findUnique({
      where: { id: trackId },
      select: { id: true, stationId: true },
    })
    if (!track || track.stationId !== stationId) {
      throw new BadRequestException('Track not found in this station')
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

    await this.normalizePendingQueuePositionsTx(tx, stationId, QueueType.USER)
    return this.snapshotQueueTx(tx, stationId)
  }

  private async applyQueuePlayNowTransitionTx(
    tx: TxClient,
    stationId: string,
    commandId: string,
    now: Date,
  ) {
    const state = await this.loadOrCreateStateTx(tx, stationId)
    const nextItem = await this.resolveNextQueueItemTx(tx, stationId)
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
        payload: this.toPrismaPayload({
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
        }),
      },
    })

    return true
  }

  private async applyQueueRemoveCommandTx(
    tx: TxClient,
    stationId: string,
    payload: CommandPayload,
  ) {
    const itemId = typeof payload.itemId === 'string' ? payload.itemId : null
    if (!itemId) throw new BadRequestException('Invalid queue remove payload: itemId is required')

    const item = await tx.queueItem.findUnique({
      where: { id: itemId },
      select: { id: true, stationId: true, queueType: true, status: true },
    })
    if (!item || item.stationId !== stationId) {
      throw new BadRequestException('Queue item not found')
    }

    await tx.queueItem.delete({ where: { id: itemId } })

    if (item.status === QueueItemStatus.PENDING) {
      await this.normalizePendingQueuePositionsTx(tx, stationId, item.queueType)
    }

    return this.snapshotQueueTx(tx, stationId)
  }

  private async applyQueueReorderCommandTx(
    tx: TxClient,
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
      throw new BadRequestException('Duplicate queue item IDs in reorder payload')
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
      return this.snapshotQueueTx(tx, stationId)
    }

    const pendingIdSet = new Set(pending.map((item) => item.id))
    for (const item of requested) {
      if (!pendingIdSet.has(item.id)) {
        throw new BadRequestException(`Queue item ${item.id} not found in pending user queue`)
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

    await this.normalizePendingQueuePositionsTx(tx, stationId, QueueType.USER)
    return this.snapshotQueueTx(tx, stationId)
  }

  private toPrismaPayload(
    payload: unknown,
  ): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
    if (payload === undefined) return undefined
    if (payload === null) return Prisma.JsonNull
    return payload as Prisma.InputJsonValue
  }

  private asObject(payload: unknown): CommandPayload {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {}
    return payload as CommandPayload
  }

  private toBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (normalized === 'true' || normalized === '1') return true
      if (normalized === 'false' || normalized === '0') return false
    }
    return null
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value)
      if (Number.isFinite(parsed)) return parsed
    }
    return null
  }

  private clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value))
  }

  private currentPositionFromState(state: {
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
    return this.clamp(base, 0, duration)
  }

  private normalizeLoopMode(value: unknown): PlaybackLoopMode | null {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (raw === 'none') return PlaybackLoopMode.NONE
    if (raw === 'track') return PlaybackLoopMode.TRACK
    if (raw === 'queue') return PlaybackLoopMode.QUEUE
    return null
  }

  private toPrismaCommandType(type: SharedPlaybackCommandType): PlaybackCommandType {
    switch (type) {
      case SharedPlaybackCommandType.PLAY:
        return PrismaPlaybackCommandType.PLAY
      case SharedPlaybackCommandType.PAUSE:
        return PrismaPlaybackCommandType.PAUSE
      case SharedPlaybackCommandType.PREVIOUS:
        return PrismaPlaybackCommandType.PREVIOUS
      case SharedPlaybackCommandType.SEEK:
        return PrismaPlaybackCommandType.SEEK
      case SharedPlaybackCommandType.SKIP:
        return PrismaPlaybackCommandType.SKIP
      case SharedPlaybackCommandType.SET_LOOP:
        return PrismaPlaybackCommandType.SET_LOOP
      case SharedPlaybackCommandType.SET_SHUFFLE:
        return PrismaPlaybackCommandType.SET_SHUFFLE
      case SharedPlaybackCommandType.QUEUE_ADD:
        return PrismaPlaybackCommandType.QUEUE_ADD
      case SharedPlaybackCommandType.QUEUE_REMOVE:
        return PrismaPlaybackCommandType.QUEUE_REMOVE
      case SharedPlaybackCommandType.QUEUE_REORDER:
        return PrismaPlaybackCommandType.QUEUE_REORDER
      default:
        throw new BadRequestException(`Unsupported playback command type: ${type}`)
    }
  }

  private async assertStationMember(stationId: string, userId: string) {
    const [station, member] = await Promise.all([
      this.prisma.station.findUnique({
        where: { id: stationId },
        select: { id: true, ownerId: true },
      }),
      this.prisma.stationMember.findUnique({
        where: { stationId_userId: { stationId, userId } },
        select: { id: true },
      }),
    ])

    if (!station) throw new NotFoundException('Station not found')
    if (station.ownerId === userId || member) return
    throw new ForbiddenException('Access denied')
  }
}
