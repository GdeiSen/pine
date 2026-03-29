import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PlaybackEventType as PrismaPlaybackEventType, Prisma } from '@prisma/client'
import { WS_EVENTS_V2 } from '@web-radio/shared'
import { PrismaService } from '../../prisma/prisma.service'
import { StationGateway } from '../gateway/station.gateway'
import * as net from 'net'

type PlaybackEventRow = {
  id: string
  stationId: string
  type: PrismaPlaybackEventType
  payload: Prisma.JsonValue | null
  createdAt: Date
}

const POLL_INTERVAL_MS = Number.parseInt(process.env.PLAYBACK_OUTBOX_POLL_INTERVAL_MS ?? '400', 10)
const BATCH_SIZE = Number.parseInt(process.env.PLAYBACK_OUTBOX_BATCH_SIZE ?? '100', 10)

@Injectable()
export class PlaybackEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlaybackEventsService.name)
  private readonly liquidsoapHost = process.env.LIQUIDSOAP_TELNET_HOST ?? 'liquidsoap'
  private readonly liquidsoapPort = Number.parseInt(process.env.LIQUIDSOAP_TELNET_PORT ?? '1234', 10)
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
    }, Math.max(100, POLL_INTERVAL_MS))

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
        if (event.type === PrismaPlaybackEventType.TRACK_CHANGED) {
          const switched = await this.hasLiquidsoapSwitchedToEventTrack(event)
          if (!switched) {
            // Keep event pending; it will be retried on next flush tick.
            continue
          }
        }
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
                title: track.title,
                artist: track.artist,
                album: track.album,
                year: track.year,
                genre: track.genre,
                duration: track.duration,
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

  private async hasLiquidsoapSwitchedToEventTrack(event: PlaybackEventRow) {
    const payload = event.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return true

    const currentTrackId = (payload as Record<string, unknown>).currentTrackId
    if (typeof currentTrackId !== 'string' || currentTrackId.length === 0) return true

    try {
      const liveTrackId = await this.getLiquidsoapCurrentTrackId()
      return liveTrackId === currentTrackId
    } catch (error) {
      this.logger.warn(`Liquidsoap track verification failed: ${this.describeError(error)}`)
      return false
    }
  }

  private async runLiquidsoapCommand(command: string) {
    return new Promise<string>((resolve, reject) => {
      let settled = false
      let response = ''
      let sawEnd = false
      let wroteQuit = false

      const finish = (error?: Error | null) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else resolve(response)
      }

      const socket = net.createConnection(
        { host: this.liquidsoapHost, port: this.liquidsoapPort },
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
      socket.setTimeout(3000)
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

  private async getLiquidsoapCurrentTrackId(): Promise<string | null> {
    const allRaw = await this.runLiquidsoapCommand('request.all')
    const firstLine = allRaw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && line !== 'END' && line !== 'Bye!')
    if (!firstLine) return null

    const requestIds = firstLine.split(/\s+/).filter((value) => /^\d+$/.test(value))
    if (requestIds.length === 0) return null

    const metadataRaw = await this.runLiquidsoapCommand(`request.metadata ${requestIds[0]}`)
    const filenameMatch = metadataRaw.match(/filename="([^"]+)"/)
    if (!filenameMatch?.[1]) return null

    const trackIdMatch = filenameMatch[1].match(
      /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/,
    )
    return trackIdMatch?.[1]?.toLowerCase() ?? null
  }
}
