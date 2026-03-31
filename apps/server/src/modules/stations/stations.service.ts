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
import { v4 as uuid } from 'uuid'
import { ConfigService } from '@nestjs/config'
import { PlaybackLoopMode, TrackAssetKind } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import { CreateStationDto } from './dto/create-station.dto'
import { UpdateStationDto } from './dto/update-station.dto'
import { parseSingleByteRange } from '../../common/http-range'
import { StorageService } from '../storage/storage.service'
import { StorageScope } from '../storage/storage.config'
import { StationAccessMode, MemberRole, ROLE_PERMISSIONS, StationPlaybackMode, StreamQuality } from '@web-radio/shared'

const FALLBACK_STATION_NAME_PHRASES = [
  'Morning Static',
  'Cloudline Radio',
  'Silver Echo',
  'Night Drift',
  'Signal Harbor',
  'Neon Meadow',
  'Velvet Noise',
  'Afterglow FM',
  'Late Route',
  'Dawn Current',
  'Wild Frequency',
  'Paper Waves',
] as const

const FALLBACK_STATION_DESCRIPTION_OPENERS = [
  'A steady mix of warm melodies, relaxed beats, and tracks that keep focus without rushing the mood.',
  'A balanced stream of fresh songs and familiar favorites designed for long listening sessions.',
  'An easy-flow station with layered instrumentals, clear vocals, and a calm late-evening atmosphere.',
  'A curated set of modern indie, light electronic textures, and melodic cuts with clean transitions.',
] as const

const FALLBACK_STATION_DESCRIPTION_CLOSERS = [
  'Perfect for background listening, creative work, and quiet evenings online.',
  'Built for deep work, smooth pacing, and moments when you want music to feel effortless.',
  'Great for reading, coding, and long conversations with music that stays present but never loud.',
  'Made for daily routines where rhythm matters and every next track feels intentional.',
] as const

@Injectable()
export class StationsService {
  private static readonly MAX_STATIONS_PER_USER = 5
  private static readonly MAX_PREVIEW_VIDEOS_PER_STATION = 5

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private storageService: StorageService,
  ) {}

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
    if (dto.password) passwordEnabled = true
    if (passwordEnabled && !dto.password) {
      throw new BadRequestException('Password is required when protection is enabled')
    }

    let passwordHash: string | undefined
    if (dto.password) {
      passwordHash = await bcrypt.hash(dto.password, 10)
    }

    const providedName = this.normalizeOptionalText(dto.name)
    const providedDescription = this.normalizeOptionalText(dto.description)
    const stationName = providedName ?? this.generateFallbackStationName()
    const stationDescription = providedDescription ?? this.generateFallbackStationDescription(stationName)

    const station = await this.prisma.$transaction(async (tx) => {
      const s = await tx.station.create({
        data: {
          code,
          name: stationName,
          description: stationDescription,
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

      await tx.playbackState.create({
        data: {
          stationId: s.id,
          currentTrackId: null,
          currentQueueItemId: null,
          currentQueueType: null,
          currentPosition: 0,
          currentTrackDuration: 0,
          trackStartedAt: null,
          isPaused: true,
          pausedPosition: 0,
          loopMode: PlaybackLoopMode.NONE,
          shuffleEnabled: false,
          lastSyncedAt: new Date(),
        },
      })

      return s
    })

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

    const playback = await this.ensurePlaybackState(station.id, station.systemQueueMode)

    let currentTrack: any = null
    if (playback.currentTrackId) {
      currentTrack = await this.prisma.track.findUnique({
        where: { id: playback.currentTrackId },
        include: {
          uploadedBy: { select: { id: true, username: true, avatar: true } },
        },
      })
    }

    // Public stations are visible without authentication.
    const accessMode = this.normalizeAccessMode(station.accessMode)
    const serverTime = new Date()
    if (accessMode === StationAccessMode.PUBLIC) {
      return this.formatStation(station, station._count.members, currentTrack, serverTime, playback)
    }

    // Private station metadata requires authentication.
    if (!userId) {
      throw new ForbiddenException('Authentication required for non-public station')
    }

    return this.formatStation(station, station._count.members, currentTrack, serverTime, playback)
  }

  async getStreamInfo(code: string, userId?: string) {
    const station = await this.prisma.station.findUnique({
      where: { code },
      select: {
        id: true,
        code: true,
        ownerId: true,
        accessMode: true,
        systemQueueMode: true,
        streamQuality: true,
      },
    })

    if (!station) throw new NotFoundException('Station not found')

    const accessMode = this.normalizeAccessMode(station.accessMode)
    if (accessMode !== StationAccessMode.PUBLIC) {
      if (!userId) {
        throw new ForbiddenException('Authentication required for non-public station')
      }

      const isOwner = station.ownerId === userId
      if (!isOwner) {
        const member = await this.prisma.stationMember.findUnique({
          where: { stationId_userId: { stationId: station.id, userId } },
          select: { id: true },
        })

        if (!member) {
          throw new ForbiddenException('Access denied')
        }
      }
    }

    const { mountPath, streamUrl } = this.buildStreamEndpoints(station.code)
    const playback = await this.ensurePlaybackState(station.id, station.systemQueueMode)

    return {
      stationId: station.id,
      code: station.code,
      streamUrl,
      mountPath,
      serverTime: new Date().toISOString(),
      qualityHint: station.streamQuality,
      latencyHintMs: this.estimateLatencyHintMs(station.streamQuality),
      currentTrackId: playback.currentTrackId,
    }
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

    const playbackByStationId = await this.getPlaybackStateByStationId(stations)
    return stations.map((station) =>
      this.formatStation(
        station,
        station._count.members,
        null,
        undefined,
        playbackByStationId.get(station.id),
      ),
    )
  }

  async update(stationId: string, userId: string, dto: UpdateStationDto) {
    const current = await this.assertOwner(stationId, userId)
    this.assertPlaybackModeAllowed(dto.playbackMode)
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
        ...(dto.playbackMode && { playbackMode: this.resolvePlaybackMode(dto.playbackMode) }),
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
    const station = await this.assertOwner(stationId, userId)

    const tracks = await this.prisma.track.findMany({
      where: { stationId },
      select: {
        id: true,
        originalPath: true,
        highPath: true,
        mediumPath: true,
        lowPath: true,
        coverPath: true,
        assets: {
          select: {
            kind: true,
            objectKey: true,
          },
        },
      },
    })

    await Promise.all(tracks.map((track) => this.deleteTrackObjects(track)))
    await Promise.all(
      (station.previewVideoKeys ?? []).map((key) =>
        this.storageService.deleteObject('transcodes', key).catch(() => undefined),
      ),
    )
    const stationCoverKey = this.getStationCoverObjectKey(station.coverImage)
    if (stationCoverKey) {
      await this.storageService.deleteObject('covers', stationCoverKey).catch(() => undefined)
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
  }

  async uploadPreviewVideo(stationId: string, userId: string, file: Express.Multer.File) {
    const station = await this.assertOwner(stationId, userId)
    const existingPreviewKeys = station.previewVideoKeys ?? []

    if (!String(file.mimetype ?? '').toLowerCase().startsWith('video/')) {
      this.safeDeleteTempFile(file.path)
      throw new BadRequestException('Unsupported video format')
    }

    if (existingPreviewKeys.length >= StationsService.MAX_PREVIEW_VIDEOS_PER_STATION) {
      this.safeDeleteTempFile(file.path)
      throw new BadRequestException(
        `Maximum ${StationsService.MAX_PREVIEW_VIDEOS_PER_STATION} preview videos per station`,
      )
    }

    const ext = path.extname(file.originalname || '').toLowerCase() || '.mp4'
    const objectKey = this.storageService.buildObjectKey({
      stationId,
      scope: 'transcodes',
      fileName: `preview-${uuid()}${ext}`,
    })

    try {
      await this.storageService.uploadFile('transcodes', objectKey, file.path, file.mimetype)

      const updated = await this.prisma.station.update({
        where: { id: stationId },
        data: {
          previewVideoKeys: [...existingPreviewKeys, objectKey],
        },
        select: { id: true, previewVideoKeys: true },
      })

      return {
        previewVideos: this.buildPreviewVideoUrls(updated.id, updated.previewVideoKeys),
      }
    } catch (error) {
      await this.storageService.deleteObject('transcodes', objectKey).catch(() => undefined)
      throw error
    } finally {
      this.safeDeleteTempFile(file.path)
    }
  }

  async uploadStationCover(stationId: string, userId: string, file: Express.Multer.File) {
    const station = await this.assertOwner(stationId, userId)

    if (!String(file.mimetype ?? '').toLowerCase().startsWith('image/')) {
      this.safeDeleteTempFile(file.path)
      throw new BadRequestException('Unsupported image format')
    }

    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg'
    const objectKey = this.storageService.buildObjectKey({
      stationId,
      scope: 'covers',
      fileName: `station-cover-${uuid()}${ext}`,
    })
    const previousCoverKey = this.getStationCoverObjectKey(station.coverImage)

    try {
      await this.storageService.uploadFile('covers', objectKey, file.path, file.mimetype)

      const updated = await this.prisma.station.update({
        where: { id: stationId },
        data: { coverImage: objectKey },
        select: { id: true, coverImage: true },
      })

      if (previousCoverKey && previousCoverKey !== objectKey) {
        await this.storageService.deleteObject('covers', previousCoverKey).catch(() => undefined)
      }

      return {
        coverImage: this.buildStationCoverUrl(updated.id, updated.coverImage),
      }
    } catch (error) {
      await this.storageService.deleteObject('covers', objectKey).catch(() => undefined)
      throw error
    } finally {
      this.safeDeleteTempFile(file.path)
    }
  }

  async deleteStationCover(stationId: string, userId: string) {
    const station = await this.assertOwner(stationId, userId)
    const previousCoverKey = this.getStationCoverObjectKey(station.coverImage)

    await this.prisma.station.update({
      where: { id: stationId },
      data: { coverImage: null },
      select: { id: true },
    })

    if (previousCoverKey) {
      await this.storageService.deleteObject('covers', previousCoverKey).catch(() => undefined)
    }

    return { coverImage: null }
  }

  async deletePreviewVideo(stationId: string, index: number, userId: string) {
    if (!Number.isInteger(index) || index < 0) {
      throw new BadRequestException('Invalid preview video index')
    }

    const station = await this.assertOwner(stationId, userId)
    const keys = station.previewVideoKeys ?? []
    const key = keys[index]
    if (!key) throw new NotFoundException('Preview video not found')

    const nextKeys = keys.filter((_, idx) => idx !== index)
    const updated = await this.prisma.station.update({
      where: { id: stationId },
      data: { previewVideoKeys: nextKeys },
      select: { id: true, previewVideoKeys: true },
    })

    await this.storageService.deleteObject('transcodes', key).catch(() => undefined)

    return {
      previewVideos: this.buildPreviewVideoUrls(updated.id, updated.previewVideoKeys),
    }
  }

  async streamPreviewVideo(
    stationId: string,
    index: number,
    res: any,
    rangeHeader: string | undefined,
    userId?: string,
  ) {
    if (!Number.isInteger(index) || index < 0) {
      throw new BadRequestException('Invalid preview video index')
    }

    const station = await this.prisma.station.findUnique({
      where: { id: stationId },
      select: {
        id: true,
        ownerId: true,
        accessMode: true,
        previewVideoKeys: true,
      },
    })
    if (!station) throw new NotFoundException('Station not found')
    await this.assertStationReadable(station, userId)

    const objectKey = station.previewVideoKeys?.[index]
    if (!objectKey) throw new NotFoundException('Preview video not found')

    const mimeType = this.getMimeTypeByExt(objectKey, 'video/mp4')
    const stat = await this.storageService.getObjectStat('transcodes', objectKey).catch(() => null)
    const totalSize = stat?.size ?? 0

    const byteRange = parseSingleByteRange(rangeHeader, totalSize)
    if (byteRange.kind === 'unsatisfiable') {
      res.set({
        'Content-Range': `bytes */${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      })
      res.status(416).end()
      return
    }

    if (byteRange.kind === 'partial') {
      res.set({
        'Content-Range': `bytes ${byteRange.start}-${byteRange.end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': byteRange.length,
        'Content-Type': mimeType,
        'Cache-Control': 'no-store',
      })
      res.status(206)

      try {
        const stream = await this.storageService.getPartialObjectStream(
          'transcodes',
          objectKey,
          byteRange.start,
          byteRange.length,
        )
        stream.on('error', () => {
          if (!res.headersSent) res.status(500).end()
          else res.end()
        })
        stream.pipe(res)
      } catch {
        throw new NotFoundException('Preview video file not found')
      }
      return
    }

    res.set({
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      ...(totalSize > 0 ? { 'Content-Length': totalSize } : {}),
      'Cache-Control': 'no-store',
    })
    res.status(200)

    try {
      const stream = await this.storageService.getObjectStream('transcodes', objectKey)
      stream.on('error', () => {
        if (!res.headersSent) res.status(500).end()
        else res.end()
      })
      stream.pipe(res)
    } catch {
      throw new NotFoundException('Preview video file not found')
    }
  }

  async streamStationCover(stationId: string, res: any, userId?: string) {
    const station = await this.prisma.station.findUnique({
      where: { id: stationId },
      select: {
        id: true,
        ownerId: true,
        accessMode: true,
        coverImage: true,
      },
    })
    if (!station) throw new NotFoundException('Station not found')
    await this.assertStationReadable(station, userId)

    const objectKey = this.getStationCoverObjectKey(station.coverImage)
    if (!objectKey) throw new NotFoundException('Station cover not found')

    const mimeType = this.getMimeTypeByExt(objectKey, 'image/jpeg')
    res.set({
      'Content-Type': mimeType,
      'Cache-Control': 'no-store',
    })
    res.status(200)

    try {
      const stream = await this.storageService.getObjectStream('covers', objectKey)
      stream.on('error', () => {
        if (!res.headersSent) res.status(500).end()
        else res.end()
      })
      stream.pipe(res)
    } catch {
      throw new NotFoundException('Station cover file not found')
    }
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

    const playbackByStationId = await this.getPlaybackStateByStationId(stations)
    return stations.map((station) =>
      this.formatStation(
        station,
        station._count.members,
        null,
        undefined,
        playbackByStationId.get(station.id),
      ),
    )
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

  private normalizeOptionalText(value?: string | null) {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized.length > 0 ? normalized : undefined
  }

  private pickRandom<T>(items: readonly T[]): T {
    return items[Math.floor(Math.random() * items.length)]
  }

  private generateFallbackStationName() {
    return this.pickRandom(FALLBACK_STATION_NAME_PHRASES)
  }

  private generateFallbackStationDescription(stationName: string) {
    const opener = this.pickRandom(FALLBACK_STATION_DESCRIPTION_OPENERS)
    const closer = this.pickRandom(FALLBACK_STATION_DESCRIPTION_CLOSERS)
    const description = `${stationName} brings a carefully selected vibe. ${opener} ${closer}`
    if (description.length <= 300) return description
    return `${description.slice(0, 297).trimEnd()}...`
  }

  private async assertOwner(stationId: string, userId: string) {
    const station = await this.prisma.station.findUnique({ where: { id: stationId } })
    if (!station) throw new NotFoundException('Station not found')
    if (station.ownerId !== userId) throw new ForbiddenException('Access denied')
    return station
  }

  private async assertStationReadable(
    station: { id: string; ownerId: string; accessMode: string },
    userId?: string,
  ) {
    const accessMode = this.normalizeAccessMode(station.accessMode)
    if (accessMode === StationAccessMode.PUBLIC) return

    if (!userId) {
      throw new ForbiddenException('Authentication required for non-public station')
    }
    if (station.ownerId === userId) return

    const member = await this.prisma.stationMember.findUnique({
      where: { stationId_userId: { stationId: station.id, userId } },
      select: { id: true },
    })
    if (!member) throw new ForbiddenException('Access denied')
  }

  private buildPreviewVideoUrls(stationId: string, keys?: string[] | null) {
    if (!Array.isArray(keys) || keys.length === 0) return []
    return keys.map((_key, index) => `/api/stations/${stationId}/preview-videos/${index}/stream`)
  }

  private getStationCoverObjectKey(rawCoverImage: string | null | undefined) {
    if (typeof rawCoverImage !== 'string') return null
    const value = rawCoverImage.trim()
    if (!value) return null
    return value.startsWith('stations/') ? value : null
  }

  private buildStationCoverUrl(stationId: string, rawCoverImage: string | null | undefined) {
    const objectKey = this.getStationCoverObjectKey(rawCoverImage)
    if (objectKey) return `/api/stations/${stationId}/cover/stream`

    if (typeof rawCoverImage === 'string' && rawCoverImage.trim().length > 0) {
      return rawCoverImage
    }

    return null
  }

  private formatStation(
    station: any,
    listenerCount: number,
    currentTrack?: any | null,
    serverTime?: Date,
    playback?: {
      currentTrackId: string | null
      currentPosition: number
      isPaused: boolean
      trackStartedAt: Date | null
      pausedPosition: number
    } | null,
  ) {
    const playbackState = playback ?? {
      currentTrackId: null,
      currentPosition: 0,
      isPaused: true,
      trackStartedAt: null,
      pausedPosition: 0,
    }

    const accessMode = this.normalizeAccessMode(station.accessMode)
    return {
      id: station.id,
      code: station.code,
      name: station.name,
      description: station.description,
      coverImage: this.buildStationCoverUrl(station.id, station.coverImage),
      previewVideos: this.buildPreviewVideoUrls(station.id, station.previewVideoKeys),
      ownerId: station.ownerId,
      owner: station.owner,
      accessMode,
      isPasswordProtected: !!station.passwordHash,
      isLive: station.isLive,
      currentTrackId: playbackState.currentTrackId,
      currentTrack: currentTrack
        ? {
            id: currentTrack.id,
            filename: currentTrack.filename,
            title: currentTrack.title,
            artist: currentTrack.artist,
            album: currentTrack.album,
            year: currentTrack.year,
            genre: currentTrack.genre,
            duration: currentTrack.duration,
            bitrate: currentTrack.bitrate,
            hasCover: !!currentTrack.coverPath,
            quality: currentTrack.quality,
            uploadedBy: currentTrack.uploadedBy,
          }
        : null,
      currentPosition: playbackState.currentPosition,
      isPaused: playbackState.isPaused,
      trackStartedAt: playbackState.trackStartedAt,
      pausedPosition: playbackState.pausedPosition,
      crossfadeDuration: station.crossfadeDuration,
      streamQuality: station.streamQuality,
      playbackMode: this.resolvePlaybackMode(
        (station.playbackMode as StationPlaybackMode | undefined) ?? StationPlaybackMode.DIRECT,
      ),
      activePlaylistId: station.activePlaylistId,
      listenerCount,
      createdAt: station.createdAt,
      ...(serverTime ? { serverTime: serverTime.toISOString() } : {}),
    }
  }

  private async getPlaybackStateByStationId(
    stations: Array<{ id: string; systemQueueMode: string }>,
  ) {
    const playbackByStationId = new Map<
      string,
      {
        currentTrackId: string | null
        currentPosition: number
        isPaused: boolean
        trackStartedAt: Date | null
        pausedPosition: number
      }
    >()

    await Promise.all(
      stations.map(async (station) => {
        const playback = await this.ensurePlaybackState(station.id, station.systemQueueMode)
        playbackByStationId.set(station.id, playback)
      }),
    )

    return playbackByStationId
  }

  private scopeByAssetKind(kind: TrackAssetKind): StorageScope | null {
    switch (kind) {
      case TrackAssetKind.ORIGINAL:
        return 'tracks'
      case TrackAssetKind.COVER_WEBP:
        return 'covers'
      case TrackAssetKind.TRANSCODE_LOW:
      case TrackAssetKind.TRANSCODE_MEDIUM:
      case TrackAssetKind.TRANSCODE_HIGH:
      case TrackAssetKind.WAVEFORM_JSON:
        return 'transcodes'
      default:
        return null
    }
  }

  private async deleteTrackObjects(track: {
    originalPath: string
    highPath: string | null
    mediumPath: string | null
    lowPath: string | null
    coverPath: string | null
    assets: Array<{ kind: TrackAssetKind; objectKey: string }>
  }) {
    const deletions: Array<{ scope: StorageScope; key: string }> = []

    for (const asset of track.assets) {
      const scope = this.scopeByAssetKind(asset.kind)
      if (!scope) continue
      deletions.push({ scope, key: asset.objectKey })
    }

    if (track.originalPath) deletions.push({ scope: 'tracks', key: track.originalPath })
    if (track.highPath) deletions.push({ scope: 'transcodes', key: track.highPath })
    if (track.mediumPath) deletions.push({ scope: 'transcodes', key: track.mediumPath })
    if (track.lowPath) deletions.push({ scope: 'transcodes', key: track.lowPath })
    if (track.coverPath) deletions.push({ scope: 'covers', key: track.coverPath })

    await Promise.all(
      deletions.map((entry) =>
        this.storageService.deleteObject(entry.scope, entry.key).catch(() => undefined),
      ),
    )
  }

  private async ensurePlaybackState(stationId: string, systemQueueMode: string) {
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
        shuffleEnabled: systemQueueMode !== 'SEQUENTIAL',
        lastSyncedAt: new Date(),
      },
      update: {
        shuffleEnabled: systemQueueMode !== 'SEQUENTIAL',
      },
    })
  }

  private normalizeAccessMode(accessMode?: string | null): StationAccessMode {
    if (accessMode === StationAccessMode.PUBLIC) return StationAccessMode.PUBLIC
    if (accessMode === StationAccessMode.PRIVATE || accessMode == null) {
      return StationAccessMode.PRIVATE
    }
    throw new BadRequestException(`Unsupported access mode: ${accessMode}`)
  }

  private resolvePlaybackMode(playbackMode?: StationPlaybackMode | string | null) {
    if (this.isDirectOnlyDeployment()) {
      return StationPlaybackMode.DIRECT
    }

    return playbackMode === StationPlaybackMode.BROADCAST
      ? StationPlaybackMode.BROADCAST
      : StationPlaybackMode.DIRECT
  }

  private assertPlaybackModeAllowed(playbackMode?: StationPlaybackMode | null) {
    if (!playbackMode) return
    if (this.isDirectOnlyDeployment() && playbackMode === StationPlaybackMode.BROADCAST) {
      throw new BadRequestException('Broadcast mode is disabled in this deployment')
    }
  }

  private isDirectOnlyDeployment() {
    const mode = this.configService.get<string>('APP_DEPLOYMENT_MODE')?.trim().toLowerCase()
    return mode === 'direct'
  }

  private buildStreamEndpoints(code: string) {
    const explicitUrl =
      this.configService.get<string>('ICECAST_PUBLIC_URL')?.trim() ??
      this.configService.get<string>('PUBLIC_STREAM_URL_TEMPLATE')?.trim()

    if (explicitUrl) {
      const replaced = explicitUrl.replaceAll('{code}', code)
      const isAbsolute = /^https?:\/\//i.test(replaced)
      const normalizedRelative = replaced.startsWith('/') ? replaced : `/${replaced}`

      if (!isAbsolute) {
        return {
          mountPath: normalizedRelative,
          streamUrl: normalizedRelative,
        }
      }

      try {
        const parsed = new URL(replaced)
        const clientHost = new URL(this.getClientOrigin()).hostname
        const explicitHostIsLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
        const clientHostIsLocal = clientHost === 'localhost' || clientHost === '127.0.0.1'
        if (explicitHostIsLocal && !clientHostIsLocal) {
          throw new Error('ignore localhost explicit stream url outside local client host')
        }
        return {
          mountPath: parsed.pathname,
          streamUrl: replaced,
        }
      } catch {
        // fall through to derived mount below
      }
    }

    const icecastMount = this.configService.get<string>('ICECAST_MOUNT')?.trim() ?? '/live.mp3'
    const mountPath = icecastMount.startsWith('/') ? icecastMount : `/${icecastMount}`

    // In a reverse-proxy setup (web + api on one domain), a relative stream path
    // is the most resilient default and avoids localhost/public-host mismatches.
    if (!this.configService.get<string>('ICECAST_HOSTNAME')?.trim()) {
      return {
        mountPath,
        streamUrl: mountPath,
      }
    }

    const rawHost =
      this.configService.get<string>('ICECAST_HOSTNAME')?.trim() ??
      new URL(this.getClientOrigin()).hostname
    const protocol = this.configService.get<string>('ICECAST_USE_SSL')?.trim() === 'true'
      ? 'https'
      : 'http'
    const configuredPort = Number.parseInt(this.configService.get<string>('ICECAST_PORT') ?? '8000', 10)
    const hasPort = /:\d+$/.test(rawHost)
    const isDefaultPort = (protocol === 'http' && configuredPort === 80) || (protocol === 'https' && configuredPort === 443)
    const hostWithPort = hasPort || !Number.isFinite(configuredPort) || isDefaultPort
      ? rawHost
      : `${rawHost}:${configuredPort}`

    return {
      mountPath,
      streamUrl: `${protocol}://${hostWithPort}${mountPath}`,
    }
  }

  private getClientOrigin() {
    const clientUrl = this.configService.get<string>('CLIENT_URL', 'http://localhost:3000')
    try {
      return new URL(clientUrl).origin
    } catch {
      return clientUrl.replace(/\/+$/, '')
    }
  }

  private safeDeleteTempFile(filePath: string | undefined) {
    if (!filePath) return
    try {
      fs.unlinkSync(filePath)
    } catch {
      // no-op
    }
  }

  private getMimeTypeByExt(filePath: string, fallback: string) {
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
    if (ext === '.png') return 'image/png'
    if (ext === '.webp') return 'image/webp'
    if (ext === '.gif') return 'image/gif'
    if (ext === '.avif') return 'image/avif'
    if (ext === '.mp4') return 'video/mp4'
    if (ext === '.webm') return 'video/webm'
    if (ext === '.mov') return 'video/quicktime'
    if (ext === '.m4v') return 'video/x-m4v'
    return fallback
  }

  private estimateLatencyHintMs(quality: string) {
    switch (quality) {
      case StreamQuality.LOW:
        return 2800
      case StreamQuality.MEDIUM:
        return 2200
      case StreamQuality.HIGH:
      default:
        return 1800
    }
  }
}
