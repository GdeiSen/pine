import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common'
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

    const track = await this.prisma.track.findUnique({ where: { id: trackId } })
    if (!track) throw new NotFoundException('Track not found')
    if (track.stationId !== stationId) {
      throw new NotFoundException('Track not found in this station')
    }

    const mode = options?.mode ?? 'end'
    const beforeItemId = options?.beforeItemId

    const userQueue = await this.prisma.queueItem.findMany({
      where: { stationId, queueType: QueueType.USER, status: QueueItemStatus.PENDING },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    })

    const maxPosition = userQueue.at(-1)?.position ?? -1
    let insertPosition = maxPosition + 1

    if (beforeItemId) {
      const target = userQueue.find((item) => item.id === beforeItemId)
      if (target) {
        insertPosition = target.position
      }
    } else if (mode === 'next' || mode === 'now') {
      insertPosition = 0
    }

    if (insertPosition <= maxPosition) {
      await this.prisma.queueItem.updateMany({
        where: {
          stationId,
          queueType: QueueType.USER,
          status: QueueItemStatus.PENDING,
          position: { gte: insertPosition },
        },
        data: { position: { increment: 1 } },
      })
    }

    const item = await this.prisma.queueItem.create({
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

    return this.formatQueueItem(item)
  }

  async removeFromQueue(stationId: string, itemId: string, userId?: string) {
    if (userId) await this.assertStationMember(stationId, userId)

    const item = await this.prisma.queueItem.findUnique({ where: { id: itemId } })
    if (!item || item.stationId !== stationId) {
      throw new NotFoundException('Queue item not found')
    }

    await this.prisma.queueItem.delete({ where: { id: itemId } })

    if (item.queueType === QueueType.USER && item.status === QueueItemStatus.PENDING) {
      await this.prisma.queueItem.updateMany({
        where: {
          stationId,
          queueType: QueueType.USER,
          status: QueueItemStatus.PENDING,
          position: { gt: item.position },
        },
        data: { position: { decrement: 1 } },
      })
    }
  }

  async reorderQueue(stationId: string, items: Array<{ id: string; position: number }>, userId?: string) {
    if (userId) await this.assertStationMember(stationId, userId)

    await Promise.all(
      items.map((item) =>
        this.prisma.queueItem.updateMany({
          where: {
            id: item.id,
            stationId,
            queueType: QueueType.USER,
            status: QueueItemStatus.PENDING,
          },
          data: { position: item.position },
        }),
      ),
    )
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

    const queueType = targetQueueType ?? (item.queueType as QueueType)

    await this.prisma.queueItem.updateMany({
      where: {
        stationId: item.stationId,
        queueType,
        status: QueueItemStatus.PENDING,
      },
      data: { position: { increment: 1 } },
    })

    await this.prisma.queueItem.update({
      where: { id: queueItemId },
      data: {
        status: QueueItemStatus.PENDING,
        queueType,
        position: 0,
        playedAt: null,
      },
    })
  }

  async rebuildSystemQueue(stationId: string) {
    const station = await this.prisma.station.findUnique({
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

    // Remove existing system queue
    await this.prisma.queueItem.deleteMany({
      where: { stationId, queueType: QueueType.SYSTEM, status: QueueItemStatus.PENDING },
    })

    let tracks = activePlaylist.tracks.map((pt) => pt.track)

    // Apply shuffle if needed
    if (station.systemQueueMode === SystemQueueMode.SHUFFLE || station.systemQueueMode === SystemQueueMode.SMART_SHUFFLE) {
      tracks = this.shuffleArray(tracks)
    }

    // Create system queue items
    await this.prisma.queueItem.createMany({
      data: tracks.map((track, index) => ({
        stationId,
        trackId: track.id,
        queueType: QueueType.SYSTEM,
        position: index,
        status: QueueItemStatus.PENDING,
      })),
    })
  }

  async clearUserQueue(stationId: string) {
    await this.prisma.queueItem.deleteMany({
      where: { stationId, queueType: QueueType.USER, status: QueueItemStatus.PENDING },
    })
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
