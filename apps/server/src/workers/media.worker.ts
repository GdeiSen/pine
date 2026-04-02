/* eslint-disable no-console */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pipeline } from 'stream/promises'
import { spawn } from 'child_process'
import { v4 as uuid } from 'uuid'
import { PrismaClient, TrackAssetKind, TrackStatus } from '@prisma/client'
import {
  createMinioClientFromEnv,
  resolveStorageBucketsFromEnv,
} from '../modules/storage/storage.config'

const prisma = new PrismaClient()
const minio = createMinioClientFromEnv()
const buckets = resolveStorageBucketsFromEnv()

const POLL_INTERVAL_MS = Number.parseInt(
  process.env.MEDIA_POLL_INTERVAL_MS ?? process.env.TRANSCODE_POLL_INTERVAL_MS ?? '1500',
  10,
)
const HEARTBEAT_INTERVAL_MS = Number.parseInt(
  process.env.MEDIA_HEARTBEAT_INTERVAL_MS ?? process.env.TRANSCODE_HEARTBEAT_INTERVAL_MS ?? '30000',
  10,
)
const MAX_BATCH_PER_TICK = Number.parseInt(
  process.env.MEDIA_MAX_BATCH_PER_TICK ?? process.env.TRANSCODE_MAX_BATCH_PER_TICK ?? '5',
  10,
)
const TMP_ROOT = path.join(os.tmpdir(), 'pine-media')
const TRANSCODE_ENABLED = process.env.MEDIA_ENABLE_TRANSCODE !== '0'
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? 'ffmpeg'
const FFMPEG_CHECK_RETRY_MS = Number.parseInt(process.env.FFMPEG_CHECK_RETRY_MS ?? '60000', 10)
const FFMPEG_TRANSCODE_TIMEOUT_MS = Number.parseInt(
  process.env.FFMPEG_TRANSCODE_TIMEOUT_MS ?? '600000',
  10,
)
const TRANSCODE_PRESETS: Array<{ kind: TrackAssetKind; suffix: string; bitrateKbps: number }> = [
  { kind: TrackAssetKind.TRANSCODE_LOW, suffix: 'low', bitrateKbps: 96 },
  { kind: TrackAssetKind.TRANSCODE_MEDIUM, suffix: 'medium', bitrateKbps: 160 },
  { kind: TrackAssetKind.TRANSCODE_HIGH, suffix: 'high', bitrateKbps: 256 },
]

let ffmpegState: { available: boolean; checkedAt: number; warnedAt: number } = {
  available: false,
  checkedAt: 0,
  warnedAt: 0,
}

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

function computeBitrateKbps(args: {
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

function resolveTranscodeKey(trackId: string, stationId: string, suffix: string) {
  return `stations/${stationId}/transcodes/${trackId}-${suffix}.m4a`
}

async function runSpawn(args: string[], options?: { timeoutMs?: number }) {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const stderrChunks: string[] = []
    let timedOut = false
    const timeoutMs = Math.max(1_000, options?.timeoutMs ?? FFMPEG_TRANSCODE_TIMEOUT_MS)
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)

    proc.stderr.on('data', (chunk) => {
      stderrChunks.push(String(chunk))
    })

    proc.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
        return
      }
      const stderr = stderrChunks.join('').trim()
      const reason = timedOut
        ? `timed out after ${timeoutMs}ms`
        : `exit code ${code ?? 'unknown'}`
      reject(new Error(stderr ? `${reason}: ${stderr}` : reason))
    })
  })
}

async function ensureFfmpegAvailable() {
  if (!TRANSCODE_ENABLED) {
    return false
  }

  const now = Date.now()
  if (ffmpegState.available && ffmpegState.checkedAt > 0) {
    return true
  }

  if (!ffmpegState.available && now - ffmpegState.checkedAt < Math.max(1_000, FFMPEG_CHECK_RETRY_MS)) {
    return false
  }

  try {
    await runSpawn(['-version'], { timeoutMs: 8_000 })
    ffmpegState = {
      available: true,
      checkedAt: now,
      warnedAt: ffmpegState.warnedAt,
    }
    console.log(`[${nowIso()}] ffmpeg detected at "${FFMPEG_BIN}"`)
    return true
  } catch (error) {
    ffmpegState = {
      available: false,
      checkedAt: now,
      warnedAt: ffmpegState.warnedAt,
    }
    if (now - ffmpegState.warnedAt > FFMPEG_CHECK_RETRY_MS) {
      ffmpegState.warnedAt = now
      console.warn(
        `[${nowIso()}] ffmpeg not available (${safeMessage(error)}). Transcode generation is paused.`,
      )
    }
    return false
  }
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

async function claimNextTrack(transcodeEnabled: boolean) {
  return prisma.$transaction(async (tx) => {
    const rows = transcodeEnabled
      ? await tx.$queryRaw<Array<{ id: string }>>`
          SELECT t.id
          FROM tracks t
          WHERE t.status IN (${TrackStatus.PROCESSING}::"track_status", ${TrackStatus.READY}::"track_status")
            AND (
              NOT EXISTS (
                SELECT 1
                FROM track_assets ta
                WHERE ta."trackId" = t.id
                  AND ta.kind = ${TrackAssetKind.TRANSCODE_LOW}::"track_asset_kind"
              )
              OR NOT EXISTS (
                SELECT 1
                FROM track_assets ta
                WHERE ta."trackId" = t.id
                  AND ta.kind = ${TrackAssetKind.TRANSCODE_MEDIUM}::"track_asset_kind"
              )
              OR NOT EXISTS (
                SELECT 1
                FROM track_assets ta
                WHERE ta."trackId" = t.id
                  AND ta.kind = ${TrackAssetKind.TRANSCODE_HIGH}::"track_asset_kind"
              )
            )
          ORDER BY t."updatedAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `
      : await tx.$queryRaw<Array<{ id: string }>>`
          SELECT t.id
          FROM tracks t
          WHERE t.status = ${TrackStatus.PROCESSING}::"track_status"
          ORDER BY t."updatedAt" ASC
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

type GeneratedTranscodeAsset = {
  kind: TrackAssetKind
  objectKey: string
  mimeType: string
  byteSize: number
  bitrate: number | null
  sampleRate: number | null
  channels: number | null
  duration: number | null
}

async function generateTranscodes(args: {
  track: ClaimedTrack
  inputPath: string
  transcodeEnabled: boolean
}): Promise<GeneratedTranscodeAsset[]> {
  if (!args.transcodeEnabled) return []

  const generated: GeneratedTranscodeAsset[] = []
  const tmpOutputs: string[] = []
  const { parseFile } = await import('music-metadata')

  try {
    for (const preset of TRANSCODE_PRESETS) {
      const outputPath = path.join(TMP_ROOT, `${args.track.id}-${preset.suffix}-${uuid()}.m4a`)
      tmpOutputs.push(outputPath)

      await runSpawn(
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          args.inputPath,
          '-vn',
          '-map_metadata',
          '-1',
          '-c:a',
          'aac',
          '-b:a',
          `${preset.bitrateKbps}k`,
          '-ac',
          '2',
          '-movflags',
          '+faststart',
          outputPath,
        ],
        { timeoutMs: FFMPEG_TRANSCODE_TIMEOUT_MS },
      )

      const stat = fs.statSync(outputPath)
      const meta = await parseFile(outputPath).catch(() => null)
      const duration =
        typeof meta?.format?.duration === 'number' && Number.isFinite(meta.format.duration)
          ? meta.format.duration
          : null
      const bitrate = computeBitrateKbps({
        reportedBitrateBps:
          typeof meta?.format?.bitrate === 'number' ? meta.format.bitrate : null,
        durationSeconds: duration,
        fileSizeBytes: stat.size,
      })
      const sampleRate =
        typeof meta?.format?.sampleRate === 'number' && Number.isFinite(meta.format.sampleRate)
          ? meta.format.sampleRate
          : null
      const channels =
        typeof meta?.format?.numberOfChannels === 'number' &&
        Number.isFinite(meta.format.numberOfChannels)
          ? meta.format.numberOfChannels
          : 2

      const objectKey = resolveTranscodeKey(args.track.id, args.track.stationId, preset.suffix)
      await minio.putObject(buckets.transcodes, objectKey, fs.createReadStream(outputPath), stat.size, {
        'Content-Type': 'audio/mp4',
      })

      generated.push({
        kind: preset.kind,
        objectKey,
        mimeType: 'audio/mp4',
        byteSize: stat.size,
        bitrate,
        sampleRate,
        channels,
        duration,
      })
    }

    return generated
  } finally {
    for (const tmpOutput of tmpOutputs) {
      fs.unlink(tmpOutput, () => undefined)
    }
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

async function processTrack(track: ClaimedTrack, options: { transcodeEnabled: boolean }) {
  const input = await resolveInputFile(track)

  try {
    const stat = fs.statSync(input.localPath)
    const { parseFile } = await import('music-metadata')
    const metadata = await parseFile(input.localPath)
    const common = metadata?.common ?? {}
    const format = metadata?.format ?? {}
    const duration = typeof format.duration === 'number' && Number.isFinite(format.duration) ? format.duration : 0
    const assetDuration = duration > 0 ? duration : null
    const bitrateKbps = computeBitrateKbps({
      reportedBitrateBps: typeof format.bitrate === 'number' ? format.bitrate : null,
      durationSeconds: duration,
      fileSizeBytes: stat.size,
    })
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
    let transcodeAssets: GeneratedTranscodeAsset[] = []
    try {
      transcodeAssets = await generateTranscodes({
        track,
        inputPath: input.localPath,
        transcodeEnabled: options.transcodeEnabled,
      })
    } catch (error) {
      console.warn(
        `[${nowIso()}] transcode failed for track ${track.id}, keeping original asset only: ${safeMessage(error)}`,
      )
      transcodeAssets = []
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
          duration,
          bitrate: bitrateKbps,
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
          bitrate: bitrateKbps,
          sampleRate: format.sampleRate ?? null,
          channels: format.numberOfChannels ?? null,
          duration: assetDuration,
        },
        update: {
          objectKey: input.objectKey,
          mimeType: getMimeFromExt(track.filename, 'audio/mpeg'),
          byteSize: stat.size,
          bitrate: bitrateKbps,
          sampleRate: format.sampleRate ?? null,
          channels: format.numberOfChannels ?? null,
          duration: assetDuration,
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

      for (const transcode of transcodeAssets) {
        await tx.trackAsset.upsert({
          where: {
            trackId_kind: {
              trackId: track.id,
              kind: transcode.kind,
            },
          },
          create: {
            trackId: track.id,
            kind: transcode.kind,
            objectKey: transcode.objectKey,
            mimeType: transcode.mimeType,
            byteSize: transcode.byteSize,
            bitrate: transcode.bitrate,
            sampleRate: transcode.sampleRate,
            channels: transcode.channels,
            duration: transcode.duration,
          },
          update: {
            objectKey: transcode.objectKey,
            mimeType: transcode.mimeType,
            byteSize: transcode.byteSize,
            bitrate: transcode.bitrate,
            sampleRate: transcode.sampleRate,
            channels: transcode.channels,
            duration: transcode.duration,
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
    const ffmpegAvailable = await ensureFfmpegAvailable()
    const transcodeEnabled = TRANSCODE_ENABLED && ffmpegAvailable
    let processed = 0
    while (!stopped && processed < Math.max(1, MAX_BATCH_PER_TICK)) {
      const track = await claimNextTrack(transcodeEnabled)
      if (!track) break

      try {
        await processTrack(track, { transcodeEnabled })
      } catch (error) {
        const message = safeMessage(error)
        console.error(`[${nowIso()}] media processing failed for track ${track.id}: ${message}`)
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
  console.log(`[${nowIso()}] media-worker stopping`)
  try {
    await prisma.$disconnect()
  } finally {
    process.exit(0)
  }
}

async function bootstrap() {
  await prisma.$connect()
  console.log(`[${nowIso()}] media-worker started`)

  setInterval(() => {
    void runLoop().catch((error) => {
      console.error(`[${nowIso()}] media loop error: ${safeMessage(error)}`)
    })
  }, Math.max(POLL_INTERVAL_MS, 200))

  setInterval(() => {
    console.log(`[${nowIso()}] media-worker heartbeat`)
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
  console.error(`[${nowIso()}] media-worker bootstrap failed: ${safeMessage(error)}`)
  await prisma.$disconnect()
  process.exit(1)
})
