import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common'
import { PlaybackEventType, Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import { QueueType, QueueItemStatus, SystemQueueMode } from '@web-radio/shared'

type AddToQueueOptions = {
  mode?: 'end' | 'next' | 'now'
  beforeItemId?: string
}

@Injectable()
export class QueueService {
  constructor(private prisma: PrismaService) {}

  async getQueue(stationId: string, userId?: string) {
    if (userId) await this.assertStationMember(stationId, userId)

    const items = await this.prisma.queueItem.findMany({
      where: { stationId, status: QueueItemStatus.PENDING },
      include: {
        track: {
          include: {
            uploadedBy: { select: { id: true, username: true, avatar: true } },
          },
        },
        addedBy: { select: { id: true, username: true, avatar: true } },
      },
      orderBy: [{ queueType: 'asc' }, { position: 'asc' }],
    })

    const brokenItems = items.filter((item) => !item.track).map((item) => item.id)
    if (brokenItems.length > 0) {
      await this.prisma.queueItem.deleteMany({
        where: { id: { in: brokenItems } },
      })
    }

    const sorted = items
      .filter((item) => !!item.track)
      .sort((a, b) => {
        if (a.queueType === b.queueType) return a.position - b.position
        return a.queueType === QueueType.USER ? -1 : 1
      })

    return sorted.map(this.formatQueueItem).filter((item) => !!item)
  }

  async addToQueue(stationId: string, trackId: string, userId: string, options?: AddToQueueOptions) {
    await this.assertStationMember(stationId, userId)

    const mode = options?.mode ?? 'end'
    const beforeItemId = options?.beforeItemId

    const item = await this.withStationQueueLock(stationId, async (tx) => {
      const track = await tx.track.findUnique({ where: { id: trackId } })
      if (!track || track.stationId !== stationId) {
        throw new NotFoundException('Track not found in this station')
      }

      const userQueue = await tx.queueItem.findMany({
        where: { stationId, queueType: QueueType.USER, status: QueueItemStatus.PENDING },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, position: true },
      })

      const maxPosition = userQueue.at(-1)?.position ?? -1
      let insertPosition = maxPosition + 1

      if (beforeItemId) {
        const target = userQueue.find((queueItem) => queueItem.id === beforeItemId)
        if (target) insertPosition = target.position
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

      const created = await tx.queueItem.create({
        data: {
          stationId,
          trackId,
          addedById: userId,
          queueType: QueueType.USER,
          position: insertPosition,
          status: QueueItemStatus.PENDING,
        },
        include: {
          track: {
            include: {
              uploadedBy: { select: { id: true, username: true, avatar: true } },
            },
          },
          addedBy: { select: { id: true, username: true, avatar: true } },
        },
      })

      await this.normalizePendingQueuePositionsTx(tx, stationId, QueueType.USER)
      const persisted = await tx.queueItem.findUnique({
        where: { id: created.id },
        include: {
          track: {
            include: {
              uploadedBy: { select: { id: true, username: true, avatar: true } },
            },
          },
          addedBy: { select: { id: true, username: true, avatar: true } },
        },
      })

      return persisted ?? created
    })

    await this.enqueueQueueUpdatedEvent(stationId)
    return this.formatQueueItem(item)
  }

  async removeFromQueue(stationId: string, itemId: string, userId?: string) {
    if (userId) await this.assertStationMember(stationId, userId)

    await this.withStationQueueLock(stationId, async (tx) => {
      const item = await tx.queueItem.findUnique({ where: { id: itemId } })
      if (!item || item.stationId !== stationId) {
        throw new NotFoundException('Queue item not found')
      }

      await tx.queueItem.delete({ where: { id: itemId } })

      if (item.queueType === QueueType.USER && item.status === QueueItemStatus.PENDING) {
        await this.normalizePendingQueuePositionsTx(tx, stationId, QueueType.USER)
      }
    })

    await this.enqueueQueueUpdatedEvent(stationId)
  }

  async reorderQueue(stationId: string, items: Array<{ id: string; position: number }>, userId?: string) {
    if (userId) await this.assertStationMember(stationId, userId)

    await this.withStationQueueLock(stationId, async (tx) => {
      const pending = await tx.queueItem.findMany({
        where: {
          stationId,
          queueType: QueueType.USER,
          status: QueueItemStatus.PENDING,
        },
        select: { id: true, position: true, createdAt: true },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      })

      if (pending.length === 0) return

      const requested = items.map((item) => ({
        id: item.id,
        position: Number.isFinite(item.position) ? item.position : 0,
      }))
      const uniqueIds = new Set(requested.map((item) => item.id))
      if (uniqueIds.size !== requested.length) {
        throw new BadRequestException('Duplicate queue item IDs in reorder payload')
      }

      const pendingIdSet = new Set(pending.map((item) => item.id))
      for (const item of requested) {
        if (!pendingIdSet.has(item.id)) {
          throw new NotFoundException(`Queue item ${item.id} not found in pending user queue`)
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
    })

    await this.enqueueQueueUpdatedEvent(stationId)
    return this.getQueue(stationId)
  }

  async getNextTrack(stationId: string): Promise<{ trackId: string; queueItemId: string } | null> {
    // self-healing lookup: removes dangling queue items instead of returning broken IDs
    for (let attempt = 0; attempt < 100; attempt++) {
      const userItem = await this.prisma.queueItem.findFirst({
        where: { stationId, queueType: QueueType.USER, status: QueueItemStatus.PENDING },
        orderBy: { position: 'asc' },
      })

      if (userItem) {
        const trackExists = await this.prisma.track.findFirst({
          where: { id: userItem.trackId, stationId },
          select: { id: true },
        })
        if (trackExists) return { trackId: userItem.trackId, queueItemId: userItem.id }
        await this.prisma.queueItem.deleteMany({ where: { id: userItem.id } })
        continue
      }

      const systemItem = await this.prisma.queueItem.findFirst({
        where: { stationId, queueType: QueueType.SYSTEM, status: QueueItemStatus.PENDING },
        orderBy: { position: 'asc' },
      })

      if (systemItem) {
        const trackExists = await this.prisma.track.findFirst({
          where: { id: systemItem.trackId, stationId },
          select: { id: true },
        })
        if (trackExists) return { trackId: systemItem.trackId, queueItemId: systemItem.id }
        await this.prisma.queueItem.deleteMany({ where: { id: systemItem.id } })
        continue
      }

      return null
    }

    return null
  }

  async markPlaying(queueItemId: string) {
    await this.prisma.queueItem.update({
      where: { id: queueItemId },
      data: { status: QueueItemStatus.PLAYING },
    })
  }

  async markPlayed(queueItemId: string) {
    await this.prisma.queueItem.update({
      where: { id: queueItemId },
      data: { status: QueueItemStatus.PLAYED, playedAt: new Date() },
    })
  }

  async requeuePlayingItem(queueItemId: string, targetQueueType?: QueueType) {
    const item = await this.prisma.queueItem.findUnique({
      where: { id: queueItemId },
      select: {
        id: true,
        stationId: true,
        queueType: true,
        status: true,
      },
    })

    if (!item || item.status !== QueueItemStatus.PLAYING) return

    await this.withStationQueueLock(item.stationId, async (tx) => {
      const queueType = targetQueueType ?? (item.queueType as QueueType)

      await tx.queueItem.updateMany({
        where: {
          stationId: item.stationId,
          queueType,
          status: QueueItemStatus.PENDING,
        },
        data: { position: { increment: 1 } },
      })

      await tx.queueItem.update({
        where: { id: queueItemId },
        data: {
          status: QueueItemStatus.PENDING,
          queueType,
          position: 0,
          playedAt: null,
        },
      })

      await this.normalizePendingQueuePositionsTx(tx, item.stationId, queueType)
    })
  }

  async rebuildSystemQueue(stationId: string) {
    await this.withStationQueueLock(stationId, async (tx) => {
      const station = await tx.station.findUnique({
        where: { id: stationId },
        include: {
          playlists: {
            where: { id: { not: undefined } },
            include: {
              tracks: {
                include: { track: true },
                orderBy: { sortOrder: 'asc' },
              },
            },
          },
        },
      })

      if (!station?.activePlaylistId) return

      const activePlaylist = station.playlists.find((p) => p.id === station.activePlaylistId)
      if (!activePlaylist) return

      await tx.queueItem.deleteMany({
        where: { stationId, queueType: QueueType.SYSTEM, status: QueueItemStatus.PENDING },
      })

      let tracks = activePlaylist.tracks.map((pt) => pt.track)
      if (
        station.systemQueueMode === SystemQueueMode.SHUFFLE ||
        station.systemQueueMode === SystemQueueMode.SMART_SHUFFLE
      ) {
        tracks = this.shuffleArray(tracks)
      }

      await tx.queueItem.createMany({
        data: tracks.map((track, index) => ({
          stationId,
          trackId: track.id,
          queueType: QueueType.SYSTEM,
          position: index,
          status: QueueItemStatus.PENDING,
        })),
      })

      await this.normalizePendingQueuePositionsTx(tx, stationId, QueueType.SYSTEM)
    })

    await this.enqueueQueueUpdatedEvent(stationId)
  }

  async clearUserQueue(stationId: string) {
    await this.withStationQueueLock(stationId, async (tx) => {
      await tx.queueItem.deleteMany({
        where: { stationId, queueType: QueueType.USER, status: QueueItemStatus.PENDING },
      })
    })

    await this.enqueueQueueUpdatedEvent(stationId)
  }

  async hasPendingUserQueue(stationId: string) {
    const count = await this.prisma.queueItem.count({
      where: {
        stationId,
        queueType: QueueType.USER,
        status: QueueItemStatus.PENDING,
      },
    })
    return count > 0
  }

  async getPreviousSystemTrack(stationId: string) {
    const item = await this.prisma.queueItem.findFirst({
      where: {
        stationId,
        queueType: QueueType.SYSTEM,
        status: QueueItemStatus.PLAYED,
      },
      orderBy: [{ playedAt: 'desc' }, { position: 'desc' }],
      select: { id: true, trackId: true },
    })

    if (!item) return null
    return { queueItemId: item.id, trackId: item.trackId }
  }

  private shuffleArray<T>(arr: T[]): T[] {
    const a = [...arr]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }

  private formatQueueItem(item: any) {
    if (!item?.track) return null
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

  private async withStationQueueLock<T>(
    stationId: string,
    task: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${stationId}))`
      return task(tx)
    })
  }

  private async normalizePendingQueuePositionsTx(
    tx: Prisma.TransactionClient,
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

  private async enqueueQueueUpdatedEvent(stationId: string) {
    const queue = await this.getQueue(stationId)
    await this.prisma.playbackEvent.create({
      data: {
        stationId,
        type: PlaybackEventType.QUEUE_UPDATED,
        payload: { queue },
      },
    })
  }
}
