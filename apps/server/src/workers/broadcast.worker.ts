/* eslint-disable no-console */
/**
 * broadcast.worker.ts
 *
 * Standalone Liquidsoap/Icecast sync daemon for BROADCAST-mode stations.
 * This module can be disabled or removed to completely deactivate Icecast/Liquidsoap support
 * without affecting core playback logic (handled by playback.worker.ts).
 *
 * Responsibilities:
 * - Watch PlaybackState.version for BROADCAST stations
 * - Write control files for Liquidsoap (playlist.m3u, state.json)
 * - Trigger Liquidsoap skip via telnet when track changes
 */
import { createHash } from 'crypto'
import * as net from 'net'
import * as path from 'path'
import * as fs from 'fs/promises'
import { PlaybackLoopMode, PrismaClient, QueueItemStatus, QueueType } from '@prisma/client'
import {
  createMinioClientFromEnv,
  resolveBucketByScope,
  resolveStorageBucketsFromEnv,
} from '../modules/storage/storage.config'

const prisma = new PrismaClient()
const minioClient = createMinioClientFromEnv()
const storageBuckets = resolveStorageBucketsFromEnv()
const tracksBucket = resolveBucketByScope('tracks', storageBuckets)

const POLL_INTERVAL_MS = Number.parseInt(process.env.BROADCAST_POLL_INTERVAL_MS ?? '500', 10)
const LIQUIDSOAP_CONTROL_DIR = process.env.LIQUIDSOAP_CONTROL_DIR ?? '/var/lib/liquidsoap/control'
const LIQUIDSOAP_CACHE_DIR = process.env.LIQUIDSOAP_CACHE_DIR ?? '/var/lib/liquidsoap/cache'
const LIQUIDSOAP_TELNET_HOST = process.env.LIQUIDSOAP_TELNET_HOST ?? 'liquidsoap'
const LIQUIDSOAP_TELNET_PORT = Number.parseInt(process.env.LIQUIDSOAP_TELNET_PORT ?? '1234', 10)
const LIQUIDSOAP_SOURCE_ID = (process.env.LIQUIDSOAP_SOURCE_ID ?? 'radio').trim() || 'radio'
const CONTROL_PLAYLIST_FILE = path.join(LIQUIDSOAP_CONTROL_DIR, 'playlist.m3u')
const CONTROL_STATE_FILE = path.join(LIQUIDSOAP_CONTROL_DIR, 'state.json')
const CONTROL_ACTIVE_STATION_FILE = path.join(LIQUIDSOAP_CONTROL_DIR, 'active-station.json')
const PLAYLIST_PREFETCH_LIMIT = Math.max(
  5,
  Number.parseInt(process.env.LIQUIDSOAP_PLAYLIST_PREFETCH_LIMIT ?? '100', 10),
)

// Track last-seen state per station to detect changes
const stationVersions = new Map<string, number>()
const stationTrackIds = new Map<string, string | null>()
const controlFingerprints = new Map<string, string>()
const controlInFlight = new Set<string>()

let stopped = false
let polling = false

type TrackRow = {
  id: string
  stationId: string
  originalPath: string
  filename: string
  title: string | null
  artist: string | null
  duration: number
}

function nowIso() {
  return new Date().toISOString()
}

function safeMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

async function ensureDirectory(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

async function writeAtomic(filePath: string, content: string) {
  await ensureDirectory(path.dirname(filePath))
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tempPath, content, 'utf8')
  await fs.rename(tempPath, filePath)
}

async function ensureCachedTrack(track: TrackRow) {
  const extension = path.extname(track.originalPath) || path.extname(track.filename) || '.mp3'
  const stationCacheDir = path.join(LIQUIDSOAP_CACHE_DIR, track.stationId)
  const cachePath = path.join(stationCacheDir, `${track.id}${extension}`)

  try {
    const stat = await fs.stat(cachePath)
    if (stat.size > 0) return cachePath
  } catch {
    // cache miss, download below
  }

  await ensureDirectory(stationCacheDir)
  const tempPath = `${cachePath}.partial-${process.pid}-${Date.now()}`
  await minioClient.fGetObject(tracksBucket, track.originalPath, tempPath)
  await fs.rename(tempPath, cachePath)
  return cachePath
}

async function sendLiquidsoapRawCommand(command: string, options?: { tolerateUnknown?: boolean }) {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let response = ''
    let sawEnd = false
    let wroteQuit = false
    const finish = (error?: Error | null) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }

    const socket = net.createConnection(
      { host: LIQUIDSOAP_TELNET_HOST, port: LIQUIDSOAP_TELNET_PORT },
      () => {
        socket.write(`${command}\n`, 'utf8', (writeError) => {
          if (writeError) {
            finish(writeError instanceof Error ? writeError : new Error(String(writeError)))
            socket.destroy()
          }
        })
      },
    )

    socket.setEncoding('utf8')
    socket.setTimeout(5000)
    socket.on('data', (chunk: string) => {
      response += chunk
      if (!sawEnd && /(^|\n)END(\r?\n|$)/.test(response)) {
        sawEnd = true
        if (!wroteQuit) {
          wroteQuit = true
          socket.write('quit\n')
        }
      }
    })
    socket.on('timeout', () => {
      finish(new Error(`Liquidsoap telnet command timed out: ${command}`))
      socket.destroy()
    })
    socket.on('error', (error) => {
      finish(error instanceof Error ? error : new Error(String(error)))
    })
    socket.on('close', () => {
      if (/ERROR:/i.test(response)) {
        if (options?.tolerateUnknown && /unknown/i.test(response)) {
          finish()
          return
        }
        finish(new Error(`Liquidsoap telnet command failed: ${command}; response=${response.trim()}`))
        return
      }
      if (!sawEnd && response.trim().length === 0) {
        finish(new Error(`Liquidsoap telnet command closed without response: ${command}`))
        return
      }
      finish()
    })
  })
}

async function sendLiquidsoapSkip() {
  await sendLiquidsoapRawCommand(`${LIQUIDSOAP_SOURCE_ID}.reload`, { tolerateUnknown: true })
  await sendLiquidsoapRawCommand(`${LIQUIDSOAP_SOURCE_ID}.skip`)
}

async function buildLiquidsoapSnapshot(stationId: string) {
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    select: { id: true, systemQueueMode: true },
  })
  if (!station) return null

  const playback = await prisma.playbackState.upsert({
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

  const currentTrack = playback.currentTrackId
    ? await prisma.track.findUnique({
        where: { id: playback.currentTrackId },
        select: {
          id: true,
          stationId: true,
          originalPath: true,
          filename: true,
          title: true,
          artist: true,
          duration: true,
        },
      })
    : null

  const queueItems = await prisma.queueItem.findMany({
    where: { stationId, status: QueueItemStatus.PENDING },
    include: {
      track: {
        select: {
          id: true,
          stationId: true,
          originalPath: true,
          filename: true,
          title: true,
          artist: true,
          duration: true,
        },
      },
    },
    orderBy: [{ queueType: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
  })

  const orderedQueueTracks = queueItems
    .filter((item) => !!item.track)
    .sort((a, b) => {
      if (a.queueType === b.queueType) return a.position - b.position
      return a.queueType === QueueType.USER ? -1 : 1
    })
    .map((item) => item.track as TrackRow)

  const trackById = new Map<string, TrackRow>()
  if (currentTrack) trackById.set(currentTrack.id, currentTrack)
  for (const track of orderedQueueTracks) {
    trackById.set(track.id, track)
  }

  const candidateTracks: TrackRow[] = []
  if (!playback.isPaused) {
    if (currentTrack) {
      candidateTracks.push(currentTrack)
    } else if (orderedQueueTracks[0]) {
      candidateTracks.push(orderedQueueTracks[0])
    }
  }

  for (const track of orderedQueueTracks) {
    if (!trackById.has(track.id)) continue
    if (candidateTracks.some((entry) => entry.id === track.id)) continue
    candidateTracks.push(track)
  }

  const limitedTracks = candidateTracks.slice(0, PLAYLIST_PREFETCH_LIMIT)

  const playableEntries: Array<TrackRow & { cachePath: string }> = []
  for (const track of limitedTracks) {
    try {
      const cachePath = await ensureCachedTrack(track)
      playableEntries.push({ ...track, cachePath })
    } catch (error) {
      console.warn(
        `[${nowIso()}] failed to cache track ${track.id} for station ${stationId}: ${safeMessage(error)}`,
      )
    }
  }

  const playlistLines = playableEntries.map((track) => track.cachePath)
  const playlistText = `${playlistLines.join('\n')}\n`
  const fingerprintSource = JSON.stringify({
    stationId,
    currentTrackId: playback.currentTrackId,
    currentQueueItemId: playback.currentQueueItemId,
    currentQueueType: playback.currentQueueType,
    currentPosition: playback.currentPosition,
    currentTrackDuration: playback.currentTrackDuration,
    isPaused: playback.isPaused,
    pausedPosition: playback.pausedPosition,
    trackStartedAt: playback.trackStartedAt?.toISOString() ?? null,
    loopMode: playback.loopMode,
    shuffleEnabled: playback.shuffleEnabled,
    tracks: playableEntries.map((track) => ({
      id: track.id,
      cachePath: track.cachePath,
      duration: track.duration,
    })),
  })
  const fingerprint = createHash('sha256').update(fingerprintSource).digest('hex')

  return {
    stationId,
    sourceId: LIQUIDSOAP_SOURCE_ID,
    fingerprint,
    playback: {
      currentTrackId: playback.currentTrackId,
      version: playback.version,
      isPaused: playback.isPaused,
      trackStartedAt: playback.trackStartedAt?.toISOString() ?? null,
      serverTime: nowIso(),
    },
    playlistText,
  }
}

async function syncLiquidsoapStation(stationId: string, isSkip = false) {
  if (controlInFlight.has(stationId)) return
  controlInFlight.add(stationId)

  try {
    const snapshot = await buildLiquidsoapSnapshot(stationId)
    if (!snapshot) return

    const previousFingerprint = controlFingerprints.get(stationId)

    await ensureDirectory(LIQUIDSOAP_CONTROL_DIR)
    await writeAtomic(CONTROL_PLAYLIST_FILE, snapshot.playlistText)
    await writeAtomic(CONTROL_STATE_FILE, `${JSON.stringify(snapshot, null, 2)}\n`)
    await writeAtomic(
      CONTROL_ACTIVE_STATION_FILE,
      `${JSON.stringify({ stationId, updatedAt: nowIso() }, null, 2)}\n`,
    )
    controlFingerprints.set(stationId, snapshot.fingerprint)

    if (isSkip || previousFingerprint !== snapshot.fingerprint) {
      await sendLiquidsoapSkip()
    }
  } catch (error) {
    console.warn(`[${nowIso()}] liquidsoap sync failed for station ${stationId}: ${safeMessage(error)}`)
  } finally {
    controlInFlight.delete(stationId)
  }
}

async function runPollLoop() {
  if (polling || stopped) return
  polling = true

  try {
    const broadcastStates = await prisma.playbackState.findMany({
      where: {
        station: { playbackMode: 'BROADCAST' },
      },
      select: {
        stationId: true,
        version: true,
        currentTrackId: true,
      },
    })

    for (const state of broadcastStates) {
      const lastVersion = stationVersions.get(state.stationId)
      const lastTrackId = stationTrackIds.get(state.stationId)

      const versionChanged = lastVersion !== undefined && lastVersion !== state.version
      const trackChanged = lastTrackId !== undefined && lastTrackId !== state.currentTrackId

      // First time seeing this station — just initialize tracking, do a baseline sync
      if (lastVersion === undefined) {
        stationVersions.set(state.stationId, state.version)
        stationTrackIds.set(state.stationId, state.currentTrackId)
        await syncLiquidsoapStation(state.stationId, false)
        continue
      }

      if (versionChanged) {
        stationVersions.set(state.stationId, state.version)
        stationTrackIds.set(state.stationId, state.currentTrackId)
        await syncLiquidsoapStation(state.stationId, trackChanged)
      }
    }
  } catch (error) {
    console.error(`[${nowIso()}] broadcast poll loop error: ${safeMessage(error)}`)
  } finally {
    polling = false
  }
}

async function shutdown() {
  if (stopped) return
  stopped = true
  console.log(`[${nowIso()}] broadcast-worker stopping`)
  try {
    await prisma.$disconnect()
  } finally {
    process.exit(0)
  }
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

console.log(
  `[${nowIso()}] broadcast-worker started (poll=${POLL_INTERVAL_MS}ms, telnet=${LIQUIDSOAP_TELNET_HOST}:${LIQUIDSOAP_TELNET_PORT})`,
)

setInterval(() => {
  void runPollLoop().catch((error) => {
    console.error(`[${nowIso()}] broadcast poll error: ${safeMessage(error)}`)
  })
}, Math.max(200, POLL_INTERVAL_MS))

// Initial run
void runPollLoop().catch((error) => {
  console.error(`[${nowIso()}] broadcast initial poll error: ${safeMessage(error)}`)
})
