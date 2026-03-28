import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { QueueService } from '../queue/queue.service'
import { IsString, MinLength, MaxLength } from 'class-validator'
import * as fs from 'fs'
import * as path from 'path'

export class CreatePlaylistDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string
}

@Injectable()
export class PlaylistsService {
  constructor(
    private prisma: PrismaService,
    private queueService: QueueService,
  ) {}

  async getStationPlaylists(stationId: string, userId: string) {
    await this.assertStationMember(stationId, userId)

    const playlists = await this.prisma.playlist.findMany({
      where: { stationId },
      include: {
        _count: { select: { tracks: true } },
        tracks: {
          include: { track: { select: { duration: true } } },
        },
      },
      orderBy: { sortOrder: 'asc' },
    })

    return playlists.map((p) => ({
      id: p.id,
      name: p.name,
      stationId: p.stationId,
      isDefault: p.isDefault,
      sortOrder: p.sortOrder,
      coverImage: p.coverImage,
      trackCount: p._count.tracks,
      totalDuration: p.tracks.reduce((sum, pt) => sum + (pt.track.duration ?? 0), 0),
      createdAt: p.createdAt,
    }))
  }

  async create(stationId: string, userId: string, dto: CreatePlaylistDto) {
    await this.assertStationAccess(stationId, userId)

    const count = await this.prisma.playlist.count({ where: { stationId } })

    return this.prisma.playlist.create({
      data: { name: dto.name, stationId, sortOrder: count },
    })
  }

  async update(playlistId: string, userId: string, name: string) {
    const playlist = await this.prisma.playlist.findUnique({ where: { id: playlistId } })
    if (!playlist) throw new NotFoundException('Playlist not found')
    await this.assertStationAccess(playlist.stationId, userId)

    return this.prisma.playlist.update({
      where: { id: playlistId },
      data: { name },
    })
  }

  async delete(playlistId: string, userId: string) {
    const playlist = await this.prisma.playlist.findUnique({ where: { id: playlistId } })
    if (!playlist) throw new NotFoundException('Playlist not found')
    if (playlist.isDefault) throw new ForbiddenException('Cannot delete default playlist')
    await this.assertStationAccess(playlist.stationId, userId)

    const trackLinks = await this.prisma.playlistTrack.findMany({
      where: { playlistId },
      select: { trackId: true },
    })
    const trackIds = Array.from(new Set(trackLinks.map((item) => item.trackId)))

    await this.prisma.playlist.delete({ where: { id: playlistId } })

    if (!trackIds.length) return

    const orphanTracks = await this.prisma.track.findMany({
      where: {
        id: { in: trackIds },
        playlists: { none: {} },
      },
      select: {
        id: true,
        originalPath: true,
        highPath: true,
        mediumPath: true,
        lowPath: true,
        coverPath: true,
      },
    })

    for (const track of orphanTracks) {
      const files = [
        track.originalPath,
        track.highPath,
        track.mediumPath,
        track.lowPath,
        track.coverPath,
      ].filter((value): value is string => Boolean(value))

      for (const filePath of files) {
        this.safeDeleteStorageFile(filePath)
      }
    }

    if (orphanTracks.length) {
      await this.prisma.track.deleteMany({
        where: { id: { in: orphanTracks.map((t) => t.id) } },
      })
    }
  }

  async activate(playlistId: string, stationId: string, userId: string) {
    await this.assertStationAccess(stationId, userId)

    const playlist = await this.prisma.playlist.findUnique({ where: { id: playlistId } })
    if (!playlist || playlist.stationId !== stationId) {
      throw new NotFoundException('Playlist not found')
    }

    await this.prisma.station.update({
      where: { id: stationId },
      data: { activePlaylistId: playlistId },
    })

    await this.queueService.rebuildSystemQueue(stationId)
  }

  async reorderTracks(
    playlistId: string,
    userId: string,
    items: Array<{ trackId: string; sortOrder: number }>,
  ) {
    const playlist = await this.prisma.playlist.findUnique({ where: { id: playlistId } })
    if (!playlist) throw new NotFoundException('Playlist not found')
    await this.assertStationAccess(playlist.stationId, userId)

    await Promise.all(
      items.map((item) =>
        this.prisma.playlistTrack.updateMany({
          where: { playlistId, trackId: item.trackId },
          data: { sortOrder: item.sortOrder },
        }),
      ),
    )
  }

  private async assertStationAccess(stationId: string, userId: string) {
    const station = await this.prisma.station.findUnique({ where: { id: stationId } })
    if (!station) throw new NotFoundException('Station not found')
    if (station.ownerId !== userId) {
      // Check if admin
      const member = await this.prisma.stationMember.findUnique({
        where: { stationId_userId: { stationId, userId } },
      })
      if (!member || !['ADMIN', 'OWNER'].includes(member.role)) {
        throw new ForbiddenException('Access denied')
      }
    }
  }

  private async assertStationMember(stationId: string, userId: string) {
    const station = await this.prisma.station.findUnique({ where: { id: stationId } })
    if (!station) throw new NotFoundException('Station not found')
    if (station.ownerId === userId) return

    const member = await this.prisma.stationMember.findUnique({
      where: { stationId_userId: { stationId, userId } },
    })
    if (!member) throw new ForbiddenException('Access denied')
  }

  private safeDeleteStorageFile(rawPath: string) {
    try {
      const storageRoot = path.resolve(process.env.STORAGE_PATH ?? './storage')
      const resolved = path.resolve(rawPath)
      if (!resolved.startsWith(`${storageRoot}${path.sep}`)) return
      if (fs.existsSync(resolved)) fs.unlinkSync(resolved)
    } catch {
      // no-op: deleting stale files should not fail playlist removal
    }
  }
}
