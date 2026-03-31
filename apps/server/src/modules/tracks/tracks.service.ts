import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common'
import { TrackAssetKind } from '@prisma/client'
import * as fs from 'fs'
import * as path from 'path'
import { v4 as uuid } from 'uuid'
import { PrismaService } from '../../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { StorageScope } from '../storage/storage.config'
import { parseSingleByteRange } from '../../common/http-range'
import {
  TrackStatus,
  TrackQuality,
  SUPPORTED_AUDIO_FORMATS,
  SUPPORTED_EXTENSIONS,
  USER_STORAGE_LIMIT_BYTES,
} from '@web-radio/shared'

@Injectable()
export class TracksService {
  private readonly logger = new Logger(TracksService.name)

  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
  ) {}

  async upload(
    stationId: string,
    playlistId: string,
    userId: string,
    file: Express.Multer.File,
  ) {
    if (!this.isSupportedAudioUpload(file)) {
      this.safeDeleteTempFile(file.path)
      throw new BadRequestException('Unsupported audio format')
    }

    await this.assertStationMember(stationId, userId)
    await this.assertPlaylistBelongsToStation(playlistId, stationId)

    const usedStorage = await this.getUserUsedStorageBytes(userId)
    if (usedStorage + file.size > USER_STORAGE_LIMIT_BYTES) {
      this.safeDeleteTempFile(file.path)
      const available = Math.max(USER_STORAGE_LIMIT_BYTES - usedStorage, 0)
      throw new BadRequestException(
        `Storage limit exceeded. Available ${this.formatBytes(available)} of ${this.formatBytes(USER_STORAGE_LIMIT_BYTES)}.`,
      )
    }

    const fallbackExt = path.extname(file.originalname).toLowerCase() || '.mp3'
    const objectFileName = file.filename || `${uuid()}${fallbackExt}`
    const originalObjectKey = this.storageService.buildObjectKey({
      stationId,
      scope: 'tracks',
      fileName: objectFileName,
    })

    try {
      await this.storageService.uploadFile('tracks', originalObjectKey, file.path, file.mimetype)

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
      const bitrate = this.computeBitrateKbps({
        reportedBitrateBps: typeof format.bitrate === 'number' ? format.bitrate : null,
        durationSeconds: duration,
        fileSizeBytes: file.size,
      })

      let quality = TrackQuality.MEDIUM
      if (this.isFlacUpload(file) || format.lossless === true) {
        quality = TrackQuality.LOSSLESS
      } else if (bitrate) {
        if (bitrate >= 300) quality = TrackQuality.HIGH
        else if (bitrate <= 80) quality = TrackQuality.LOW
      }

      const track = await this.prisma.track.create({
        data: {
          stationId,
          uploadedById: userId,
          filename: file.originalname,
          originalPath: originalObjectKey,
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

      await this.prisma.trackAsset.upsert({
        where: {
          trackId_kind: {
            trackId: track.id,
            kind: TrackAssetKind.ORIGINAL,
          },
        },
        create: {
          trackId: track.id,
          kind: TrackAssetKind.ORIGINAL,
          objectKey: originalObjectKey,
          mimeType: file.mimetype || 'audio/mpeg',
          byteSize: file.size,
          bitrate,
          sampleRate: format.sampleRate ?? null,
          channels: format.numberOfChannels ?? null,
          duration: format.duration ?? null,
        },
        update: {
          objectKey: originalObjectKey,
          mimeType: file.mimetype || 'audio/mpeg',
          byteSize: file.size,
          bitrate,
          sampleRate: format.sampleRate ?? null,
          channels: format.numberOfChannels ?? null,
          duration: format.duration ?? null,
        },
      })

      if (common.picture?.[0]) {
        await this.saveCover(track.id, stationId, common.picture[0])
      }

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
    } catch (error) {
      await this.storageService.deleteObject('tracks', originalObjectKey).catch(() => undefined)
      throw error
    } finally {
      this.safeDeleteTempFile(file.path)
    }
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

    return items.map((item) => ({
      ...this.formatTrack(item.track),
      sortOrder: item.sortOrder,
      addedById: item.addedById,
      addedAt: item.addedAt,
    }))
  }

  async getCover(trackId: string, res: any, userId?: string) {
    const track = await this.prisma.track.findUnique({ where: { id: trackId } })
    if (!track) throw new NotFoundException('Track not found')
    await this.assertStationReadable(track.stationId, userId)

    if (!track.coverPath) {
      throw new NotFoundException('Cover file not found')
    }

    try {
      const stream = await this.storageService.getObjectStream('covers', track.coverPath)
      res.set({
        'Content-Type': this.getMimeTypeByExt(track.coverPath, 'image/webp'),
        'Cache-Control': 'public, max-age=86400',
      })
      stream.on('error', () => {
        if (!res.headersSent) {
          res.status(404).end()
          return
        }
        res.end()
      })
      stream.pipe(res)
    } catch {
      throw new NotFoundException('Cover file not found')
    }
  }

  async deleteTrack(trackId: string, userId: string) {
    const track = await this.prisma.track.findUnique({
      where: { id: trackId },
      include: { assets: true },
    })
    if (!track) throw new NotFoundException('Track not found')

    const station = await this.prisma.station.findUnique({ where: { id: track.stationId } })
    if (track.uploadedById !== userId && station?.ownerId !== userId) {
      throw new ForbiddenException('Cannot delete this track')
    }

    await this.deleteTrackAssets(track)
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

  async streamTrack(trackId: string, res: any, rangeHeader: string | undefined, userId?: string) {
    const track = await this.prisma.track.findUnique({
      where: { id: trackId },
      include: {
        assets: {
          where: { kind: TrackAssetKind.ORIGINAL },
          take: 1,
        },
      },
    })
    if (!track) throw new NotFoundException('Track not found')
    await this.assertStationReadable(track.stationId, userId)

    const objectKey = track.originalPath
    if (!objectKey) throw new NotFoundException('Track file not found')

    const mimeType = track.assets[0]?.mimeType ?? 'audio/mpeg'
    const stat = await this.storageService.getObjectStat('tracks', objectKey).catch(() => null)
    const totalSize = stat?.size ?? track.fileSize ?? 0

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
          'tracks',
          objectKey,
          byteRange.start,
          byteRange.length,
        )
        stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.end() })
        stream.pipe(res)
      } catch {
        throw new NotFoundException('Track file not found')
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
      const stream = await this.storageService.getObjectStream('tracks', objectKey)
      stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.end() })
      stream.pipe(res)
    } catch {
      throw new NotFoundException('Track file not found')
    }
  }

  async getWaveform(trackId: string, userId?: string) {
    const track = await this.prisma.track.findUnique({ where: { id: trackId } })
    if (!track) throw new NotFoundException('Track not found')
    await this.assertStationReadable(track.stationId, userId)
    if (!track.waveformData) return { data: [] }
    return { data: JSON.parse(track.waveformData) }
  }

  private async saveCover(
    trackId: string,
    stationId: string,
    picture: { data: Uint8Array | Buffer; format?: string },
  ): Promise<string | null> {
    const pictureBuffer = Buffer.from(picture.data)
    const coverBaseObjectKey = this.storageService.buildObjectKey({
      stationId,
      scope: 'covers',
      fileName: trackId,
    })

    try {
      const sharpFactory = await this.resolveSharpFactory()
      const webpBuffer = await sharpFactory(pictureBuffer)
        .rotate()
        .resize(500, 500, { fit: 'cover' })
        .webp({ quality: 85 })
        .toBuffer()

      const objectKey = `${coverBaseObjectKey}.webp`

      await this.storageService.uploadBuffer('covers', objectKey, webpBuffer, 'image/webp')
      await this.persistCoverAsset(trackId, objectKey, 'image/webp', webpBuffer.byteLength)
      return objectKey
    } catch (error) {
      this.logger.warn(
        `Cover optimize failed for track ${trackId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    try {
      const ext = this.getImageExtension(picture.format)
      const objectKey = `${coverBaseObjectKey}${ext}`
      const mimeType = this.getMimeTypeByExt(`cover${ext}`, 'image/jpeg')

      await this.storageService.uploadBuffer('covers', objectKey, pictureBuffer, mimeType)
      await this.persistCoverAsset(trackId, objectKey, mimeType, pictureBuffer.byteLength)
      return objectKey
    } catch (error) {
      this.logger.warn(
        `Cover save failed for track ${trackId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return null
    }
  }

  private async persistCoverAsset(
    trackId: string,
    objectKey: string,
    mimeType: string,
    byteSize: number,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.track.update({
        where: { id: trackId },
        data: { coverPath: objectKey },
      })
      await tx.trackAsset.upsert({
        where: {
          trackId_kind: {
            trackId,
            kind: TrackAssetKind.COVER_WEBP,
          },
        },
        create: {
          trackId,
          kind: TrackAssetKind.COVER_WEBP,
          objectKey,
          mimeType,
          byteSize,
        },
        update: {
          objectKey,
          mimeType,
          byteSize,
        },
      })
    })
  }

  private async deleteTrackAssets(track: {
    id: string
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

    const unique = new Map<string, { scope: StorageScope; key: string }>()
    for (const item of deletions) {
      unique.set(`${item.scope}:${item.key}`, item)
    }

    await Promise.all(
      [...unique.values()].map((item) =>
        this.storageService.deleteObject(item.scope, item.key).catch(() => undefined),
      ),
    )
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

  private normalizeMimeType(value?: string | null) {
    return String(value ?? '').trim().toLowerCase()
  }

  private isFallbackBinaryMime(value?: string | null) {
    const mime = this.normalizeMimeType(value)
    return mime.length === 0 || mime === 'application/octet-stream' || mime === 'binary/octet-stream'
  }

  private isSupportedAudioUpload(file: Express.Multer.File) {
    const mime = this.normalizeMimeType(file.mimetype)
    const ext = path.extname(file.originalname || '').toLowerCase()
    const isExtAllowed = SUPPORTED_EXTENSIONS.includes(ext)
    const isMimeAllowed = SUPPORTED_AUDIO_FORMATS.includes(mime)
    return isExtAllowed && (isMimeAllowed || mime.startsWith('audio/') || this.isFallbackBinaryMime(mime))
  }

  private isFlacUpload(file: Express.Multer.File) {
    const mime = this.normalizeMimeType(file.mimetype)
    const ext = path.extname(file.originalname || '').toLowerCase()
    return mime === 'audio/flac' || mime === 'audio/x-flac' || ext === '.flac'
  }

  private computeBitrateKbps(args: {
    reportedBitrateBps?: number | null
    durationSeconds?: number | null
    fileSizeBytes?: number | null
  }) {
    const reportedKbps =
      typeof args.reportedBitrateBps === 'number' && Number.isFinite(args.reportedBitrateBps) && args.reportedBitrateBps > 0
        ? Math.round(args.reportedBitrateBps / 1000)
        : null

    const estimatedKbps =
      typeof args.durationSeconds === 'number' &&
      Number.isFinite(args.durationSeconds) &&
      args.durationSeconds > 0 &&
      typeof args.fileSizeBytes === 'number' &&
      Number.isFinite(args.fileSizeBytes) &&
      args.fileSizeBytes > 0
        ? Math.round((args.fileSizeBytes * 8) / (args.durationSeconds * 1000))
        : null

    if (reportedKbps && estimatedKbps) {
      const ratio = reportedKbps / Math.max(estimatedKbps, 1)
      if (ratio < 0.65 || ratio > 1.55) {
        return estimatedKbps
      }
    }

    return reportedKbps ?? estimatedKbps ?? null
  }

  private safeDeleteTempFile(filePath?: string) {
    try {
      if (!filePath) return
      if (!path.isAbsolute(filePath)) return
      if (filePath.startsWith('/tmp/') || filePath.includes(`${path.sep}pine-uploads${path.sep}`)) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      }
    } catch {
      // best effort temp cleanup
    }
  }

  private getMimeTypeByExt(filePath: string, fallback: string) {
    const ext = path.extname(filePath).toLowerCase()
    const map: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
    }
    return map[ext] ?? fallback
  }

  private getImageExtension(format?: string | null) {
    const normalized = (format ?? '').trim().toLowerCase()
    if (!normalized) return '.jpg'
    if (normalized.includes('png')) return '.png'
    if (normalized.includes('webp')) return '.webp'
    if (normalized.includes('gif')) return '.gif'
    if (normalized.includes('bmp')) return '.bmp'
    return '.jpg'
  }

  private async resolveSharpFactory() {
    const sharpModule = (await import('sharp')) as any
    const sharpFactory =
      typeof sharpModule === 'function'
        ? sharpModule
        : typeof sharpModule?.default === 'function'
          ? sharpModule.default
          : null

    if (!sharpFactory) {
      throw new Error('sharp module is not callable')
    }

    return sharpFactory as (input: Buffer) => any
  }

  private async getUserUsedStorageBytes(userId: string) {
    const usage = await this.prisma.track.aggregate({
      where: { uploadedById: userId },
      _sum: { fileSize: true },
    })

    return usage._sum.fileSize ?? 0
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
