import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common'
import * as fs from 'fs'
import * as path from 'path'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../../prisma/prisma.service'
import {
  TrackStatus,
  TrackQuality,
  SUPPORTED_AUDIO_FORMATS,
  StreamQuality,
  USER_STORAGE_LIMIT_BYTES,
} from '@web-radio/shared'

@Injectable()
export class TracksService {
  private storagePath: string
  private readonly logger = new Logger(TracksService.name)
  private readonly coverExtractionFailed = new Set<string>()

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    this.storagePath = path.resolve(this.configService.get<string>('STORAGE_PATH', './storage'))
  }

  async upload(
    stationId: string,
    playlistId: string,
    userId: string,
    file: Express.Multer.File,
  ) {
    // Validate file type
    if (!SUPPORTED_AUDIO_FORMATS.includes(file.mimetype)) {
      this.safeDeleteFile(file.path)
      throw new BadRequestException('Unsupported audio format')
    }

    await this.assertStationMember(stationId, userId)
    await this.assertPlaylistBelongsToStation(playlistId, stationId)

    const usedStorage = await this.getUserUsedStorageBytes(userId)
    if (usedStorage + file.size > USER_STORAGE_LIMIT_BYTES) {
      this.safeDeleteFile(file.path)
      const available = Math.max(USER_STORAGE_LIMIT_BYTES - usedStorage, 0)
      throw new BadRequestException(
        `Storage limit exceeded. Available ${this.formatBytes(available)} of ${this.formatBytes(USER_STORAGE_LIMIT_BYTES)}.`,
      )
    }

    // Parse metadata
    let metadata: any = {}
    try {
      const { parseFile } = await import('music-metadata')
      metadata = await parseFile(file.path)
    } catch (error: any) {
      this.logger.warn(
        `Metadata parsing failed for ${file.originalname}: ${error?.message ?? String(error)}`,
      )
    }

    const common = metadata?.common ?? {}
    const format = metadata?.format ?? {}
    const duration = format.duration ?? 0
    const bitrate = format.bitrate ? Math.round(format.bitrate / 1000) : null

    // Determine quality
    let quality = TrackQuality.MEDIUM
    if (bitrate) {
      if (bitrate >= 300) quality = TrackQuality.HIGH
      else if (bitrate <= 80) quality = TrackQuality.LOW
    }
    if (file.mimetype === 'audio/flac') quality = TrackQuality.LOSSLESS

    // Create track record
    const track = await this.prisma.track.create({
      data: {
        stationId,
        uploadedById: userId,
        filename: file.originalname,
        originalPath: file.path,
        title: common.title ?? null,
        artist: common.artist ?? null,
        album: common.album ?? null,
        year: common.year ?? null,
        genre: common.genre?.[0] ?? null,
        duration,
        fileSize: file.size,
        bitrate,
        sampleRate: format.sampleRate ?? null,
        quality,
        status: TrackStatus.READY,
      },
      include: {
        uploadedBy: { select: { id: true, username: true, avatar: true } },
      },
    })

    // Extract and save cover if present
    if (common.picture?.[0]) {
      await this.saveCover(track.id, stationId, common.picture[0])
    } else {
      // Fallback for files where picture was not exposed by initial parse.
      await this.ensureCoverForTrack(track)
    }

    // Add to playlist
    const playlistTrackCount = await this.prisma.playlistTrack.count({
      where: { playlistId },
    })

    await this.prisma.playlistTrack.create({
      data: {
        playlistId,
        trackId: track.id,
        sortOrder: playlistTrackCount,
        addedById: userId,
      },
    })

    return this.formatTrack(track)
  }

  async getStationTracks(stationId: string, userId: string) {
    await this.assertStationMember(stationId, userId)

    const tracks = await this.prisma.track.findMany({
      where: { stationId },
      include: {
        uploadedBy: { select: { id: true, username: true, avatar: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    await Promise.all(
      tracks.map(async (track) => {
        const coverPath = await this.ensureCoverForTrack(track)
        if (coverPath) track.coverPath = coverPath
      }),
    )

    return tracks.map(this.formatTrack)
  }

  async getPlaylistTracks(playlistId: string, userId: string) {
    const playlist = await this.prisma.playlist.findUnique({
      where: { id: playlistId },
      select: { stationId: true },
    })
    if (!playlist) throw new NotFoundException('Playlist not found')
    await this.assertStationMember(playlist.stationId, userId)

    const items = await this.prisma.playlistTrack.findMany({
      where: { playlistId },
      include: {
        track: {
          include: {
            uploadedBy: { select: { id: true, username: true, avatar: true } },
          },
        },
      },
      orderBy: { sortOrder: 'asc' },
    })

    await Promise.all(
      items.map(async (item) => {
        const coverPath = await this.ensureCoverForTrack(item.track)
        if (coverPath) item.track.coverPath = coverPath
      }),
    )

    return items.map((item) => ({
      ...this.formatTrack(item.track),
      sortOrder: item.sortOrder,
      addedById: item.addedById,
      addedAt: item.addedAt,
    }))
  }

  async streamTrack(
    trackId: string,
    range: string | undefined,
    res: any,
    qualityParam?: string,
    userId?: string,
  ) {
    const track = await this.prisma.track.findUnique({ where: { id: trackId } })
    if (!track) throw new NotFoundException('Track not found')
    await this.assertStationReadable(track.stationId, userId)

    const quality = (qualityParam ?? '').toUpperCase()
    const desired = Object.values(StreamQuality).includes(quality as StreamQuality)
      ? (quality as StreamQuality)
      : StreamQuality.HIGH

    const filePath =
      desired === StreamQuality.LOW
        ? (track.lowPath ?? track.mediumPath ?? track.highPath ?? track.originalPath)
        : desired === StreamQuality.MEDIUM
          ? (track.mediumPath ?? track.highPath ?? track.lowPath ?? track.originalPath)
          : (track.highPath ?? track.mediumPath ?? track.lowPath ?? track.originalPath)

    const safePath = this.resolveSafeStorageFilePath(filePath)
    if (!safePath || !fs.existsSync(safePath)) throw new NotFoundException('Audio file not found')

    const stat = fs.statSync(safePath)
    const fileSize = stat.size
    const mimeType = this.getMimeType(safePath)

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      const chunkSize = end - start + 1

      res.status(206)
      res.set({
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
      })

      const stream = fs.createReadStream(safePath, { start, end })
      stream.pipe(res)
    } else {
      res.set({
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
      })
      fs.createReadStream(safePath).pipe(res)
    }

    // Increment play count
    this.prisma.track.update({
      where: { id: trackId },
      data: { playCount: { increment: 1 } },
    }).catch(() => {})
  }

  async getCover(trackId: string, res: any, _userId?: string) {
    const track = await this.prisma.track.findUnique({ where: { id: trackId } })
    if (!track) throw new NotFoundException('Track not found')

    const coverPath = await this.ensureCoverForTrack(track)
    if (!coverPath) {
      throw new NotFoundException('Cover file not found')
    }
    const safeCoverPath = this.resolveSafeStorageFilePath(coverPath)
    if (!safeCoverPath || !fs.existsSync(safeCoverPath)) {
      throw new NotFoundException('Cover file not found')
    }

    res.set({
      'Content-Type': this.getImageMimeType(safeCoverPath),
      'Cache-Control': 'public, max-age=86400',
    })
    fs.createReadStream(safeCoverPath).pipe(res)
  }

  async deleteTrack(trackId: string, userId: string) {
    const track = await this.prisma.track.findUnique({
      where: { id: trackId },
      include: { uploadedBy: true },
    })
    if (!track) throw new NotFoundException('Track not found')

    // Check if user is uploader or station owner
    const station = await this.prisma.station.findUnique({ where: { id: track.stationId } })
    if (track.uploadedById !== userId && station?.ownerId !== userId) {
      throw new ForbiddenException('Cannot delete this track')
    }

    // Delete files
    const files = [track.originalPath, track.coverPath].filter(Boolean) as string[]
    for (const f of files) {
      const safePath = this.resolveSafeStorageFilePath(f)
      if (safePath && fs.existsSync(safePath)) fs.unlinkSync(safePath)
    }

    await this.prisma.track.delete({ where: { id: trackId } })
  }

  async updateTrack(
    trackId: string,
    userId: string,
    patch: { title?: string | null },
  ) {
    const track = await this.prisma.track.findUnique({
      where: { id: trackId },
    })
    if (!track) throw new NotFoundException('Track not found')

    const station = await this.prisma.station.findUnique({ where: { id: track.stationId } })
    if (!station) throw new NotFoundException('Station not found')

    if (track.uploadedById !== userId && station.ownerId !== userId) {
      const member = await this.prisma.stationMember.findUnique({
        where: { stationId_userId: { stationId: station.id, userId } },
      })
      if (!member || !['ADMIN', 'OWNER'].includes(member.role)) {
        throw new ForbiddenException('Cannot update this track')
      }
    }

    const title = typeof patch.title === 'string' ? patch.title.trim() : null

    const updated = await this.prisma.track.update({
      where: { id: trackId },
      data: {
        title: title && title.length > 0 ? title.slice(0, 160) : null,
      },
      include: {
        uploadedBy: { select: { id: true, username: true, avatar: true } },
      },
    })

    return this.formatTrack(updated)
  }

  async getWaveform(trackId: string, userId?: string) {
    const track = await this.prisma.track.findUnique({ where: { id: trackId } })
    if (!track) throw new NotFoundException('Track not found')
    await this.assertStationReadable(track.stationId, userId)
    if (!track.waveformData) return { data: [] }
    return { data: JSON.parse(track.waveformData) }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async ensureCoverForTrack(track: {
    id: string
    stationId: string
    originalPath: string
    coverPath?: string | null
  }): Promise<string | null> {
    if (this.coverExtractionFailed.has(track.id)) return null

    const existingCoverPath = this.resolveSafeStorageFilePath(track.coverPath)
    if (existingCoverPath && fs.existsSync(existingCoverPath)) {
      this.coverExtractionFailed.delete(track.id)
      return existingCoverPath
    }

    const safeAudioPath = this.resolveSafeStorageFilePath(track.originalPath)
    if (!safeAudioPath || !fs.existsSync(safeAudioPath)) return null

    try {
      const { parseFile } = await import('music-metadata')
      const metadata = await parseFile(safeAudioPath)
      const picture = metadata?.common?.picture?.[0]
      if (!picture?.data) return null

      const saved = await this.saveCover(track.id, track.stationId, picture)
      if (saved) this.coverExtractionFailed.delete(track.id)
      else this.coverExtractionFailed.add(track.id)
      return saved
    } catch (error: any) {
      this.logger.warn(
        `Cover extraction failed for track ${track.id}: ${error?.message ?? String(error)}`,
      )
      this.coverExtractionFailed.add(track.id)
      return null
    }
  }

  private async saveCover(
    trackId: string,
    stationId: string,
    picture: { data: Uint8Array | Buffer; format?: string },
  ): Promise<string | null> {
    try {
      const sharp = (await import('sharp')).default
      const coverDir = path.join(this.storagePath, 'stations', stationId, 'covers')
      fs.mkdirSync(coverDir, { recursive: true })
      const coverData = Buffer.from(picture.data)

      const coverPath = path.join(coverDir, `${trackId}.webp`)
      await sharp(coverData)
        .rotate()
        .resize(500, 500, { fit: 'cover' })
        .webp({ quality: 85 })
        .toFile(coverPath)

      await this.prisma.track.update({
        where: { id: trackId },
        data: { coverPath },
      })
      return coverPath
    } catch (_e) {
      this.logger.warn(
        `Cover save failed for track ${trackId}, trying raw fallback: ${
          _e instanceof Error ? _e.message : String(_e)
        }`,
      )
      try {
        const coverDir = path.join(this.storagePath, 'stations', stationId, 'covers')
        fs.mkdirSync(coverDir, { recursive: true })

        const ext = this.getImageExtension(picture?.format)
        const fallbackPath = path.join(coverDir, `${trackId}${ext}`)
        fs.writeFileSync(fallbackPath, Buffer.from(picture.data))

        await this.prisma.track.update({
          where: { id: trackId },
          data: { coverPath: fallbackPath },
        })
        return fallbackPath
      } catch (fallbackError: any) {
        this.logger.warn(
          `Raw cover fallback failed for track ${trackId}: ${
            fallbackError?.message ?? String(fallbackError)
          }`,
        )
        return null
      }
    }
  }

  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    const map: Record<string, string> = {
      '.mp3': 'audio/mpeg',
      '.flac': 'audio/flac',
      '.wav': 'audio/wav',
      '.aac': 'audio/aac',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4',
    }
    return map[ext] ?? 'audio/mpeg'
  }

  private getImageExtension(format?: string | null): string {
    const f = String(format ?? '').toLowerCase()
    if (f.includes('png')) return '.png'
    if (f.includes('webp')) return '.webp'
    if (f.includes('gif')) return '.gif'
    if (f.includes('bmp')) return '.bmp'
    return '.jpg'
  }

  private getImageMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    const map: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
    }
    return map[ext] ?? 'application/octet-stream'
  }

  private async getUserUsedStorageBytes(userId: string) {
    const usage = await this.prisma.track.aggregate({
      where: { uploadedById: userId },
      _sum: { fileSize: true },
    })

    return usage._sum.fileSize ?? 0
  }

  private safeDeleteFile(filePath?: string) {
    try {
      const safePath = this.resolveSafeStorageFilePath(filePath)
      if (safePath && fs.existsSync(safePath)) {
        fs.unlinkSync(safePath)
      }
    } catch (_e) {
      // best effort cleanup
    }
  }

  private resolveSafeStorageFilePath(filePath?: string | null): string | null {
    if (!filePath) return null
    const resolved = path.resolve(filePath)
    if (resolved === this.storagePath || resolved.startsWith(`${this.storagePath}${path.sep}`)) {
      return resolved
    }
    return null
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

  private async assertPlaylistBelongsToStation(playlistId: string, stationId: string) {
    const playlist = await this.prisma.playlist.findUnique({
      where: { id: playlistId },
      select: { stationId: true },
    })
    if (!playlist) throw new NotFoundException('Playlist not found')
    if (playlist.stationId !== stationId) {
      throw new BadRequestException('Playlist does not belong to this station')
    }
  }

  private async assertStationReadable(stationId: string, userId?: string) {
    const station = await this.prisma.station.findUnique({
      where: { id: stationId },
      select: { id: true, accessMode: true, ownerId: true },
    })
    if (!station) throw new NotFoundException('Station not found')
    if (station.accessMode === 'PUBLIC') return
    if (!userId) throw new ForbiddenException('Authentication required')
    if (station.ownerId === userId) return

    const member = await this.prisma.stationMember.findUnique({
      where: { stationId_userId: { stationId: station.id, userId } },
      select: { id: true },
    })
    if (!member) throw new ForbiddenException('Access denied')
  }

  private formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  private formatTrack(track: any) {
    return {
      id: track.id,
      stationId: track.stationId,
      uploadedBy: track.uploadedBy,
      filename: track.filename,
      title: track.title,
      artist: track.artist,
      album: track.album,
      year: track.year,
      genre: track.genre,
      duration: track.duration,
      bitrate: track.bitrate,
      quality: track.quality,
      status: track.status,
      hasCover: !!track.coverPath,
      waveformData: track.waveformData ? JSON.parse(track.waveformData) : null,
      playCount: track.playCount,
      createdAt: track.createdAt,
    }
  }
}
