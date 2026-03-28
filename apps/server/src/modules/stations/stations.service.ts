import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common'
import * as bcrypt from 'bcryptjs'
import * as fs from 'fs'
import * as path from 'path'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../../prisma/prisma.service'
import { CreateStationDto } from './dto/create-station.dto'
import { UpdateStationDto } from './dto/update-station.dto'
import { StationAccessMode, MemberRole, ROLE_PERMISSIONS } from '@web-radio/shared'

@Injectable()
export class StationsService {
  private storagePath: string
  private static readonly MAX_STATIONS_PER_USER = 5

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    this.storagePath = path.resolve(
      this.configService.get<string>('STORAGE_PATH', './storage'),
    )
  }

  async create(userId: string, dto: CreateStationDto) {
    const ownedStationsCount = await this.prisma.station.count({
      where: { ownerId: userId },
    })
    if (ownedStationsCount >= StationsService.MAX_STATIONS_PER_USER) {
      throw new BadRequestException(
        `Maximum ${StationsService.MAX_STATIONS_PER_USER} stations per user`,
      )
    }

    const code = await this.generateUniqueCode()
    const accessMode = this.normalizeAccessMode(dto.accessMode)

    let passwordEnabled = dto.passwordEnabled ?? false
    if (dto.accessMode === StationAccessMode.CODE_PASSWORD) passwordEnabled = true
    if (dto.password) passwordEnabled = true
    if (passwordEnabled && !dto.password) {
      throw new BadRequestException('Password is required when protection is enabled')
    }

    let passwordHash: string | undefined
    if (dto.password) {
      passwordHash = await bcrypt.hash(dto.password, 10)
    }

    const station = await this.prisma.$transaction(async (tx) => {
      const s = await tx.station.create({
        data: {
          code,
          name: dto.name,
          description: dto.description,
          ownerId: userId,
          accessMode,
          passwordHash,
          crossfadeDuration: 3,
        },
        include: { owner: { select: { id: true, username: true, avatar: true } } },
      })

      // Create default playlist
      await tx.playlist.create({
        data: {
          name: 'Default',
          stationId: s.id,
          isDefault: true,
          sortOrder: 0,
        },
      })

      // Add owner as member
      await tx.stationMember.create({
        data: {
          stationId: s.id,
          userId,
          role: MemberRole.OWNER,
          permissions: JSON.stringify(ROLE_PERMISSIONS[MemberRole.OWNER]),
        },
      })

      return s
    })

    // Create storage directory
    this.createStationDirectory(station.id)

    return this.formatStation(station, 0)
  }

  async findByCode(code: string, userId?: string) {
    const station = await this.prisma.station.findUnique({
      where: { code },
      include: {
        owner: { select: { id: true, username: true, avatar: true } },
        _count: { select: { members: true } },
      },
    })

    if (!station) throw new NotFoundException('Station not found')

    let currentTrack: any = null
    if (station.currentTrackId) {
      currentTrack = await this.prisma.track.findUnique({
        where: { id: station.currentTrackId },
        include: {
          uploadedBy: { select: { id: true, username: true, avatar: true } },
        },
      })
    }

    // Public stations are visible without authentication.
    const accessMode = this.normalizeAccessMode(station.accessMode)
    const serverTime = new Date()
    if (accessMode === StationAccessMode.PUBLIC) {
      return this.formatStation(station, station._count.members, currentTrack, serverTime)
    }

    // Private station metadata requires authentication.
    if (!userId) {
      throw new ForbiddenException('Authentication required for non-public station')
    }

    return this.formatStation(station, station._count.members, currentTrack, serverTime)
  }

  async join(code: string, userId: string, password?: string) {
    const station = await this.prisma.station.findUnique({ where: { code } })
    if (!station) throw new NotFoundException('Station not found')

    const existing = await this.prisma.stationMember.findUnique({
      where: { stationId_userId: { stationId: station.id, userId } },
    })
    const isOwner = station.ownerId === userId

    if (!!station.passwordHash && !isOwner) {
      if (!password) throw new UnauthorizedException('Password required')
      const valid = await bcrypt.compare(password, station.passwordHash!)
      if (!valid) throw new UnauthorizedException('Wrong password')
    }

    if (!existing) {
      await this.prisma.stationMember.create({
        data: {
          stationId: station.id,
          userId,
          role: MemberRole.LISTENER,
          permissions: '[]',
        },
      })
    }

    return { stationId: station.id, code: station.code }
  }

  async getMyStations(userId: string) {
    const stations = await this.prisma.station.findMany({
      where: { ownerId: userId },
      include: {
        owner: { select: { id: true, username: true, avatar: true } },
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    return stations.map((s) => this.formatStation(s, s._count.members))
  }

  async update(stationId: string, userId: string, dto: UpdateStationDto) {
    const current = await this.assertOwner(stationId, userId)
    const nextAccessMode = dto.accessMode
      ? this.normalizeAccessMode(dto.accessMode)
      : this.normalizeAccessMode(current.accessMode)

    let passwordEnabled = dto.passwordEnabled ?? !!current.passwordHash
    if (dto.password) passwordEnabled = true

    let passwordHash: string | null | undefined
    if (passwordEnabled) {
      if (dto.password) {
        passwordHash = await bcrypt.hash(dto.password, 10)
      } else if (!current.passwordHash) {
        throw new BadRequestException('Password is required when protection is enabled')
      }
    } else {
      passwordHash = null
    }

    const station = await this.prisma.station.update({
      where: { id: stationId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.accessMode && { accessMode: nextAccessMode }),
        ...(dto.crossfadeDuration !== undefined && { crossfadeDuration: dto.crossfadeDuration }),
        ...(dto.streamQuality && { streamQuality: dto.streamQuality }),
        ...(passwordHash !== undefined && { passwordHash }),
      },
      include: {
        owner: { select: { id: true, username: true, avatar: true } },
        _count: { select: { members: true } },
      },
    })

    return this.formatStation(station, station._count.members)
  }

  async delete(stationId: string, userId: string) {
    await this.assertOwner(stationId, userId)

    const tracks = await this.prisma.track.findMany({
      where: { stationId },
      select: {
        id: true,
        originalPath: true,
        highPath: true,
        mediumPath: true,
        lowPath: true,
        coverPath: true,
      },
    })

    for (const track of tracks) {
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

    const trackIds = tracks.map((t) => t.id)
    await this.prisma.$transaction(async (tx) => {
      if (trackIds.length) {
        await tx.queueItem.deleteMany({ where: { trackId: { in: trackIds } } })
        await tx.playlistTrack.deleteMany({ where: { trackId: { in: trackIds } } })
      }
      await tx.track.deleteMany({ where: { stationId } })
      await tx.station.delete({ where: { id: stationId } })
    })

    this.removeStationDirectory(stationId)
  }

  async setLive(stationId: string, isLive: boolean) {
    return this.prisma.station.update({
      where: { id: stationId },
      data: { isLive },
    })
  }

  async getPublicStations() {
    const stations = await this.prisma.station.findMany({
      where: { accessMode: StationAccessMode.PUBLIC, isLive: true },
      include: {
        owner: { select: { id: true, username: true, avatar: true } },
        _count: { select: { members: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    })

    return stations.map((s) => this.formatStation(s, s._count.members))
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async generateUniqueCode(): Promise<string> {
    let code: string
    let attempts = 0
    do {
      code = Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join('')
      const existing = await this.prisma.station.findUnique({ where: { code } })
      if (!existing) return code
      attempts++
    } while (attempts < 100)
    throw new ConflictException('Could not generate unique code')
  }

  private createStationDirectory(stationId: string) {
    const dir = path.join(this.storagePath, 'stations', stationId)
    fs.mkdirSync(dir, { recursive: true })
  }

  private removeStationDirectory(stationId: string) {
    const dir = path.join(this.storagePath, 'stations', stationId)
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  private safeDeleteStorageFile(rawPath: string) {
    try {
      const resolved = path.resolve(rawPath)
      if (
        resolved !== this.storagePath &&
        !resolved.startsWith(`${this.storagePath}${path.sep}`)
      ) {
        return
      }
      if (fs.existsSync(resolved)) {
        fs.unlinkSync(resolved)
      }
    } catch {
      // best effort cleanup
    }
  }

  private async assertOwner(stationId: string, userId: string) {
    const station = await this.prisma.station.findUnique({ where: { id: stationId } })
    if (!station) throw new NotFoundException('Station not found')
    if (station.ownerId !== userId) throw new ForbiddenException('Access denied')
    return station
  }

  private formatStation(
    station: any,
    listenerCount: number,
    currentTrack?: any | null,
    serverTime?: Date,
  ) {
    const accessMode = this.normalizeAccessMode(station.accessMode)
    return {
      id: station.id,
      code: station.code,
      name: station.name,
      description: station.description,
      coverImage: station.coverImage,
      ownerId: station.ownerId,
      owner: station.owner,
      accessMode,
      isPasswordProtected: !!station.passwordHash,
      isLive: station.isLive,
      currentTrackId: station.currentTrackId,
      currentTrack: currentTrack
        ? {
            id: currentTrack.id,
            title: currentTrack.title,
            artist: currentTrack.artist,
            album: currentTrack.album,
            year: currentTrack.year,
            genre: currentTrack.genre,
            duration: currentTrack.duration,
            hasCover: !!currentTrack.coverPath,
            quality: currentTrack.quality,
            uploadedBy: currentTrack.uploadedBy,
          }
        : null,
      currentPosition: station.currentPosition,
      isPaused: station.isPaused,
      trackStartedAt: station.trackStartedAt,
      pausedPosition: station.pausedPosition,
      crossfadeDuration: station.crossfadeDuration,
      streamQuality: station.streamQuality,
      activePlaylistId: station.activePlaylistId,
      listenerCount,
      createdAt: station.createdAt,
      ...(serverTime ? { serverTime: serverTime.toISOString() } : {}),
    }
  }

  private normalizeAccessMode(accessMode?: string | null): StationAccessMode {
    if (accessMode === StationAccessMode.PUBLIC) return StationAccessMode.PUBLIC
    return StationAccessMode.PRIVATE
  }
}
