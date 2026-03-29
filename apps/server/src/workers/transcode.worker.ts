/* eslint-disable no-console */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pipeline } from 'stream/promises'
import { v4 as uuid } from 'uuid'
import { PrismaClient, TrackAssetKind, TrackStatus } from '@prisma/client'
import {
  createMinioClientFromEnv,
  resolveStorageBucketsFromEnv,
} from '../modules/storage/storage.config'

const prisma = new PrismaClient()
const minio = createMinioClientFromEnv()
const buckets = resolveStorageBucketsFromEnv()

const POLL_INTERVAL_MS = Number.parseInt(process.env.TRANSCODE_POLL_INTERVAL_MS ?? '1500', 10)
const HEARTBEAT_INTERVAL_MS = Number.parseInt(
  process.env.TRANSCODE_HEARTBEAT_INTERVAL_MS ?? '30000',
  10,
)
const MAX_BATCH_PER_TICK = Number.parseInt(
  process.env.TRANSCODE_MAX_BATCH_PER_TICK ?? '5',
  10,
)
const TMP_ROOT = path.join(os.tmpdir(), 'pine-transcode')

function nowIso() {
  return new Date().toISOString()
}

function safeMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function getImageExtension(format?: string | null): string {
  const normalized = String(format ?? '').toLowerCase()
  if (normalized.includes('png')) return '.png'
  if (normalized.includes('webp')) return '.webp'
  if (normalized.includes('gif')) return '.gif'
  if (normalized.includes('bmp')) return '.bmp'
  return '.jpg'
}

function getMimeFromExt(filePath: string, fallback = 'application/octet-stream') {
  const ext = path.extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
  }
  return map[ext] ?? fallback
}

async function resolveSharpFactory() {
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

type ClaimedTrack = {
  id: string
  stationId: string
  filename: string
  originalPath: string
  coverPath: string | null
  title: string | null
  artist: string | null
  album: string | null
  year: number | null
  genre: string | null
}

async function claimNextTrack() {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM tracks
      WHERE status IN (${TrackStatus.PROCESSING}::"track_status", ${TrackStatus.READY}::"track_status")
        AND ("coverPath" IS NULL)
      ORDER BY "updatedAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `

    if (rows.length === 0) return null

    return tx.track.update({
      where: { id: rows[0].id },
      data: { status: TrackStatus.PROCESSING },
      select: {
        id: true,
        stationId: true,
        filename: true,
        originalPath: true,
        coverPath: true,
        title: true,
        artist: true,
        album: true,
        year: true,
        genre: true,
      },
    })
  })
}

async function resolveInputFile(track: ClaimedTrack) {
  const objectKey = track.originalPath
  if (!objectKey || path.isAbsolute(objectKey)) {
    throw new Error(`Invalid original object key: ${track.originalPath}`)
  }

  fs.mkdirSync(TMP_ROOT, { recursive: true })
  const localPath = path.join(TMP_ROOT, `${track.id}-${uuid()}${path.extname(track.filename) || '.audio'}`)
  const stream = await minio.getObject(buckets.tracks, objectKey)
  await pipeline(stream, fs.createWriteStream(localPath))

  return {
    localPath,
    cleanup: true,
    objectKey,
  }
}

async function saveCover(params: {
  trackId: string
  stationId: string
  picture: { data: Uint8Array | Buffer; format?: string }
}) {
  const coverData = Buffer.from(params.picture.data)
  const baseKey = `stations/${params.stationId}/covers/${params.trackId}`

  try {
    const sharpFactory = await resolveSharpFactory()
    const webp = await sharpFactory(coverData)
      .rotate()
      .resize(500, 500, { fit: 'cover' })
      .webp({ quality: 85 })
      .toBuffer()
    const objectKey = `${baseKey}.webp`
    await minio.putObject(buckets.covers, objectKey, webp, webp.byteLength, {
      'Content-Type': 'image/webp',
    })
    return {
      objectKey,
      mimeType: 'image/webp',
      byteSize: webp.byteLength,
    }
  } catch {
    const ext = getImageExtension(params.picture.format)
    const mimeType = getMimeFromExt(ext, 'image/jpeg')
    const objectKey = `${baseKey}${ext}`
    await minio.putObject(buckets.covers, objectKey, coverData, coverData.byteLength, {
      'Content-Type': mimeType,
    })
    return {
      objectKey,
      mimeType,
      byteSize: coverData.byteLength,
    }
  }
}

async function processTrack(track: ClaimedTrack) {
  const input = await resolveInputFile(track)

  try {
    const stat = fs.statSync(input.localPath)
    const { parseFile } = await import('music-metadata')
    const metadata = await parseFile(input.localPath)
    const common = metadata?.common ?? {}
    const format = metadata?.format ?? {}
    const picture = common.picture?.[0]

    let coverAsset:
      | { objectKey: string; mimeType: string; byteSize: number }
      | null = null
    if (picture?.data) {
      coverAsset = await saveCover({
        trackId: track.id,
        stationId: track.stationId,
        picture,
      })
    }

    await prisma.$transaction(async (tx) => {
      await tx.track.update({
        where: { id: track.id },
        data: {
          title: track.title ?? common.title ?? null,
          artist: track.artist ?? common.artist ?? null,
          album: track.album ?? common.album ?? null,
          year: track.year ?? common.year ?? null,
          genre: track.genre ?? common.genre?.[0] ?? null,
          duration: format.duration ?? 0,
          bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null,
          sampleRate: format.sampleRate ?? null,
          fileSize: stat.size,
          ...(coverAsset ? { coverPath: coverAsset.objectKey } : {}),
          status: TrackStatus.READY,
        },
      })

      await tx.trackAsset.upsert({
        where: {
          trackId_kind: {
            trackId: track.id,
            kind: TrackAssetKind.ORIGINAL,
          },
        },
        create: {
          trackId: track.id,
          kind: TrackAssetKind.ORIGINAL,
          objectKey: input.objectKey,
          mimeType: getMimeFromExt(track.filename, 'audio/mpeg'),
          byteSize: stat.size,
          bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null,
          sampleRate: format.sampleRate ?? null,
          channels: format.numberOfChannels ?? null,
          duration: format.duration ?? null,
        },
        update: {
          objectKey: input.objectKey,
          mimeType: getMimeFromExt(track.filename, 'audio/mpeg'),
          byteSize: stat.size,
          bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null,
          sampleRate: format.sampleRate ?? null,
          channels: format.numberOfChannels ?? null,
          duration: format.duration ?? null,
        },
      })

      if (coverAsset) {
        await tx.trackAsset.upsert({
          where: {
            trackId_kind: {
              trackId: track.id,
              kind: TrackAssetKind.COVER_WEBP,
            },
          },
          create: {
            trackId: track.id,
            kind: TrackAssetKind.COVER_WEBP,
            objectKey: coverAsset.objectKey,
            mimeType: coverAsset.mimeType,
            byteSize: coverAsset.byteSize,
          },
          update: {
            objectKey: coverAsset.objectKey,
            mimeType: coverAsset.mimeType,
            byteSize: coverAsset.byteSize,
          },
        })
      }
    })
  } finally {
    if (input.cleanup) {
      fs.unlink(input.localPath, () => undefined)
    }
  }
}

let stopped = false
let polling = false

async function runLoop() {
  if (stopped || polling) return
  polling = true

  try {
    let processed = 0
    while (!stopped && processed < Math.max(1, MAX_BATCH_PER_TICK)) {
      const track = await claimNextTrack()
      if (!track) break

      try {
        await processTrack(track)
      } catch (error) {
        const message = safeMessage(error)
        console.error(`[${nowIso()}] transcode failed for track ${track.id}: ${message}`)
        await prisma.track
          .update({
            where: { id: track.id },
            data: { status: TrackStatus.ERROR },
          })
          .catch(() => undefined)
      }

      processed += 1
    }
  } finally {
    polling = false
  }
}

async function shutdown() {
  if (stopped) return
  stopped = true
  console.log(`[${nowIso()}] transcode-worker stopping`)
  try {
    await prisma.$disconnect()
  } finally {
    process.exit(0)
  }
}

async function bootstrap() {
  await prisma.$connect()
  console.log(`[${nowIso()}] transcode-worker started`)

  setInterval(() => {
    void runLoop().catch((error) => {
      console.error(`[${nowIso()}] transcode loop error: ${safeMessage(error)}`)
    })
  }, Math.max(POLL_INTERVAL_MS, 200))

  setInterval(() => {
    console.log(`[${nowIso()}] transcode-worker heartbeat`)
  }, Math.max(HEARTBEAT_INTERVAL_MS, 5_000))

  await runLoop()
}

process.on('SIGINT', () => {
  void shutdown()
})

process.on('SIGTERM', () => {
  void shutdown()
})

void bootstrap().catch(async (error) => {
  console.error(`[${nowIso()}] transcode-worker bootstrap failed: ${safeMessage(error)}`)
  await prisma.$disconnect()
  process.exit(1)
})
