import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import {
  PlaybackEventType as PrismaPlaybackEventType,
  PlaybackLoopMode,
  Prisma,
} from '@prisma/client'
import { WS_EVENTS_V2 } from '@web-radio/shared'
import { PrismaService } from '../../prisma/prisma.service'
import { StationGateway } from '../gateway/station.gateway'

type PlaybackEventRow = {
  id: string
  stationId: string
  type: PrismaPlaybackEventType
  payload: Prisma.JsonValue | null
  createdAt: Date
}

const POLL_INTERVAL_MS = Number.parseInt(process.env.PLAYBACK_OUTBOX_POLL_INTERVAL_MS ?? '100', 10)
const BATCH_SIZE = Number.parseInt(process.env.PLAYBACK_OUTBOX_BATCH_SIZE ?? '100', 10)

function toClientLoopMode(value: unknown) {
  if (value === PlaybackLoopMode.TRACK || value === 'TRACK' || value === 'track') return 'track'
  if (value === PlaybackLoopMode.QUEUE || value === 'QUEUE' || value === 'queue') return 'queue'
  return 'none'
}

@Injectable()
export class PlaybackEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlaybackEventsService.name)
  private interval: NodeJS.Timeout | null = null
  private running = false
  private stopping = false

  constructor(
    private readonly prisma: PrismaService,
    private readonly stationGateway: StationGateway,
  ) {}

  onModuleInit() {
    this.logger.log(
      `Playback outbox broadcaster started (interval=${POLL_INTERVAL_MS}ms, batch=${BATCH_SIZE})`,
    )
    this.interval = setInterval(() => {
      void this.flush().catch((error) => {
        this.logger.error(`Playback outbox flush failed: ${this.describeError(error)}`)
      })
    }, Math.max(50, POLL_INTERVAL_MS))

    void this.flush().catch((error) => {
      this.logger.error(`Initial playback outbox flush failed: ${this.describeError(error)}`)
    })
  }

  onModuleDestroy() {
    this.stopping = true
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  private async flush() {
    if (this.running || this.stopping) return
    this.running = true

    try {
      const events = await this.prisma.playbackEvent.findMany({
        where: { processedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: Math.max(1, Math.min(BATCH_SIZE, 100)),
      })

      if (events.length === 0) return
      if (!this.stationGateway.server) {
        this.logger.warn('Station gateway is not ready yet, delaying playback outbox flush')
        return
      }

      for (const event of events) {
        const envelope = await this.buildEnvelope(event)
        const wsEvent = this.mapWsEvent(event.type)

        try {
          this.stationGateway.broadcastToStation(event.stationId, wsEvent, envelope)
          await this.prisma.playbackEvent.update({
            where: { id: event.id },
            data: { processedAt: new Date() },
          })
        } catch (error) {
          this.logger.error(
            `Failed to broadcast playback event ${event.id} (${event.type}): ${this.describeError(error)}`,
          )
        }
      }
    } finally {
      this.running = false
    }
  }

  private mapWsEvent(type: PrismaPlaybackEventType) {
    switch (type) {
      case PrismaPlaybackEventType.TRACK_CHANGED:
        return WS_EVENTS_V2.TRACK_CHANGED
      case PrismaPlaybackEventType.QUEUE_UPDATED:
        return WS_EVENTS_V2.QUEUE_UPDATED
      default:
        return WS_EVENTS_V2.PLAYBACK_SYNC
    }
  }

  private async buildEnvelope(event: PlaybackEventRow) {
    const base = {
      eventId: event.id,
      stationId: event.stationId,
      serverTime: event.createdAt.toISOString(),
      event: this.mapWsEvent(event.type),
      type: event.type,
    }

    const payload = await this.normalizePayload(event)
    return {
      ...payload,
      ...base,
    }
  }

  private async normalizePayload(event: PlaybackEventRow) {
    const payload = event.payload
    if (payload === null) return {}
    if (Array.isArray(payload)) return { payload }
    if (typeof payload === 'object') {
      const normalized = { ...(payload as Record<string, unknown>) }
      if ('loopMode' in normalized) {
        normalized.loopMode = toClientLoopMode(normalized.loopMode)
      }

      if (event.type === PrismaPlaybackEventType.TRACK_CHANGED) {
        const trackId = typeof normalized.currentTrackId === 'string'
          ? normalized.currentTrackId
          : null

        if (trackId && !normalized.track) {
          const track = await this.prisma.track.findUnique({
            where: { id: trackId },
            include: {
              uploadedBy: { select: { id: true, username: true, avatar: true } },
            },
          })

          normalized.track = track
            ? {
                id: track.id,
                filename: track.filename,
                title: track.title,
                artist: track.artist,
                album: track.album,
                year: track.year,
                genre: track.genre,
                duration: track.duration,
                bitrate: track.bitrate,
                hasCover: !!track.coverPath,
                quality: track.quality,
                uploadedBy: track.uploadedBy,
              }
            : null
        }
      }

      return normalized
    }
    return { payload }
  }

  private describeError(error: unknown) {
    if (error instanceof Error) return error.message
    return String(error)
  }
}
