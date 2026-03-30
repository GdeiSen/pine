import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
  WsException,
} from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import { Logger } from '@nestjs/common'
import { PlaybackLoopMode } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import { QueueService } from '../queue/queue.service'
import { ChatService } from '../chat/chat.service'
import { StationsService } from '../stations/stations.service'
import { WS_EVENTS_V2, ChatMessageType, StationPlaybackMode } from '@web-radio/shared'
import { isAllowedOrigin, resolveAllowedOrigins } from '../../common/security/cors'

interface AuthSocket extends Socket {
  userId?: string
  username?: string
  stationId?: string
}

const gatewayAllowedOrigins = resolveAllowedOrigins(
  process.env.ALLOWED_ORIGINS,
  process.env.CLIENT_URL ?? 'http://localhost:3000',
)

@WebSocketGateway({
  namespace: '/station',
  cors: {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (isAllowedOrigin(origin, gatewayAllowedOrigins)) {
        callback(null, true)
        return
      }
      callback(new Error('Origin is not allowed by CORS'))
    },
    credentials: true,
  },
})
export class StationGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server

  private logger = new Logger('StationGateway')

  // Map: stationId → online socket IDs
  private stationSockets = new Map<string, Set<string>>()
  // Map: socketId → { userId, stationId }
  private socketMeta = new Map<string, { userId: string; stationId: string }>()

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    private prisma: PrismaService,
    private queueService: QueueService,
    private chatService: ChatService,
    private stationsService: StationsService,
  ) {}

  afterInit() {
    this.logger.log('WebSocket Gateway (v2) initialized')
  }

  async handleConnection(client: AuthSocket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '')

      if (token) {
        const payload = this.jwtService.verify(token, {
          secret: this.configService.get('JWT_SECRET'),
        })
        client.userId = payload.sub
        client.username = payload.username
      }
    } catch {
      // Anonymous connection is allowed, but joining requires auth.
    }
  }

  async handleDisconnect(client: AuthSocket) {
    await this.removeSocketFromStation(client)
  }

  @SubscribeMessage(WS_EVENTS_V2.STATION_JOIN)
  async handleJoin(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() data: { code: string; password?: string },
  ) {
    if (!/^\d{6}$/.test(data.code)) throw new WsException('Invalid station code')

    const station = await this.prisma.station.findUnique({ where: { code: data.code } })
    if (!station) throw new WsException('Station not found')

    // Allow anonymous listeners on public stations without a password.
    const isPublicOpen = station.accessMode === 'PUBLIC' && !station.passwordHash
    if (!client.userId && !isPublicOpen) {
      throw new WsException('Authentication required')
    }

    if (client.userId) {
      try {
        await this.stationsService.join(data.code, client.userId, data.password)
      } catch (err: any) {
        throw new WsException(err?.message ?? 'Failed to join station')
      }
    } else if (station.passwordHash) {
      throw new WsException('Authentication required')
    }

    await client.join(station.id)
    client.stationId = station.id

    const effectiveUserId = client.userId ?? `anon:${client.id}`
    this.socketMeta.set(client.id, { userId: effectiveUserId, stationId: station.id })
    if (!this.stationSockets.has(station.id)) {
      this.stationSockets.set(station.id, new Set())
    }
    this.stationSockets.get(station.id)!.add(client.id)

    await this.stationsService.setLive(station.id, true).catch(() => undefined)

    const state = await this.buildStationState(station.id)
    client.emit(WS_EVENTS_V2.STATION_STATE, state)

    if (client.userId) {
      const member = await this.prisma.stationMember.findUnique({
        where: { stationId_userId: { stationId: station.id, userId: client.userId } },
        include: { user: { select: { id: true, username: true, avatar: true } } },
      })

      this.server.to(station.id).except(client.id).emit(WS_EVENTS_V2.LISTENER_JOINED, {
        userId: client.userId,
        username: client.username,
        listenerCount: this.stationSockets.get(station.id)?.size ?? 1,
        member: member
          ? {
              id: member.id,
              stationId: member.stationId,
              user: member.user,
              role: member.role,
              permissions: JSON.parse(member.permissions),
              joinedAt: member.joinedAt,
              isOnline: true,
            }
          : null,
      })

      const msg = await this.chatService.createSystemMessage(
        station.id,
        `${client.username ?? 'Anonymous'} joined the station`,
        ChatMessageType.USER_JOINED,
      )
      this.server.to(station.id).emit(WS_EVENTS_V2.CHAT_MESSAGE, msg)
    }

    return { success: true, stationId: station.id }
  }

  @SubscribeMessage(WS_EVENTS_V2.STATION_LEAVE)
  async handleLeave(@ConnectedSocket() client: AuthSocket) {
    await this.removeSocketFromStation(client)
  }

  @SubscribeMessage(WS_EVENTS_V2.TIME_SYNC)
  handleTimeSync(@MessageBody() data: { clientTs?: number }) {
    return {
      clientTs: data?.clientTs,
      serverTs: Date.now(),
    }
  }

  @SubscribeMessage(WS_EVENTS_V2.CHAT_SEND)
  async handleChatSend(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() data: { content: string },
  ) {
    if (!client.userId || !client.stationId) throw new WsException('Not in a station')
    if (!data.content?.trim()) throw new WsException('Empty message')

    const msg = await this.chatService.createMessage(
      client.stationId,
      client.userId,
      data.content.trim(),
    )
    this.server.to(client.stationId).emit(WS_EVENTS_V2.CHAT_MESSAGE, msg)
  }

  @SubscribeMessage(WS_EVENTS_V2.HEARTBEAT)
  handleHeartbeat(@ConnectedSocket() client: AuthSocket) {
    if (client.userId) {
      this.prisma.user
        .update({ where: { id: client.userId }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined)
    }
    return { ok: true }
  }

  private async removeSocketFromStation(client: AuthSocket) {
    const meta = this.socketMeta.get(client.id)
    if (!meta) return

    const { stationId, userId } = meta
    this.socketMeta.delete(client.id)
    client.stationId = undefined

    try {
      await client.leave(stationId)
    } catch {
      // no-op, socket may already be detached
    }

    const sockets = this.stationSockets.get(stationId)
    if (sockets) {
      sockets.delete(client.id)
      if (sockets.size === 0) {
        this.stationSockets.delete(stationId)
        await this.stationsService.setLive(stationId, false).catch(() => undefined)
      }
    }

    this.server.to(stationId).emit(WS_EVENTS_V2.LISTENER_LEFT, {
      userId,
      username: client.username,
      listenerCount: this.stationSockets.get(stationId)?.size ?? 0,
    })

    if (client.username) {
      const msg = await this.chatService.createSystemMessage(
        stationId,
        `${client.username} left the station`,
        ChatMessageType.USER_LEFT,
      )
      this.server.to(stationId).emit(WS_EVENTS_V2.CHAT_MESSAGE, msg)
    }
  }

  private async buildStationState(stationId: string) {
    const station = await this.prisma.station.findUnique({
      where: { id: stationId },
      include: {
        owner: { select: { id: true, username: true, avatar: true } },
        playlists: {
          include: { _count: { select: { tracks: true } } },
          orderBy: { sortOrder: 'asc' },
        },
      },
    })
    if (!station) throw new WsException('Station not found')

    const queue = await this.queueService.getQueue(stationId)
    const onlineUserIds = this.getOnlineUserIds(stationId)
    const members = await this.prisma.stationMember.findMany({
      where: { stationId },
      include: { user: { select: { id: true, username: true, avatar: true } } },
      orderBy: { joinedAt: 'asc' },
    })

    const playback = await this.prisma.playbackState.upsert({
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

    let currentTrack = null
    if (playback.currentTrackId) {
      currentTrack = await this.prisma.track.findUnique({
        where: { id: playback.currentTrackId },
        include: {
          uploadedBy: { select: { id: true, username: true, avatar: true } },
        },
      })
    }

    return {
      station: {
        id: station.id,
        code: station.code,
        name: station.name,
        description: station.description,
        coverImage: station.coverImage,
        owner: station.owner,
        isLive: station.isLive,
        accessMode: station.accessMode,
        isPasswordProtected: !!station.passwordHash,
        crossfadeDuration: station.crossfadeDuration,
        streamQuality: station.streamQuality,
        playbackMode: this.resolvePlaybackMode(station.playbackMode),
        activePlaylistId: station.activePlaylistId,
        listenerCount: this.stationSockets.get(stationId)?.size ?? 0,
      },
      currentTrack: this.toClientTrack(currentTrack),
      currentPosition: this.getPlaybackPosition(playback),
      isPaused: playback.isPaused,
      trackStartedAt: playback.trackStartedAt ? playback.trackStartedAt.getTime() : null,
      currentQueueType: playback.currentQueueType,
      loopMode: this.toClientLoopMode(playback.loopMode),
      shuffleEnabled: playback.shuffleEnabled,
      queue,
      members: members.map((m) => ({
        id: m.id,
        stationId: m.stationId,
        user: m.user,
        role: m.role,
        permissions: JSON.parse(m.permissions),
        joinedAt: m.joinedAt,
        isOnline: onlineUserIds.has(m.userId),
      })),
      playlists: station.playlists,
      systemQueueMode: station.systemQueueMode,
    }
  }

  private getPlaybackPosition(playback: {
    isPaused: boolean
    pausedPosition: number
    currentPosition: number
    trackStartedAt: Date | null
    currentTrackDuration: number
  }) {
    const position =
      playback.isPaused || !playback.trackStartedAt
        ? playback.pausedPosition || playback.currentPosition || 0
        : (Date.now() - playback.trackStartedAt.getTime()) / 1000

    const maxDuration = Math.max(playback.currentTrackDuration || 0, 0)
    if (maxDuration > 0) {
      return Math.max(0, Math.min(position, maxDuration))
    }

    return Math.max(0, position)
  }

  private toClientTrack(
    track: {
      id: string
      filename: string
      title: string | null
      artist: string | null
      album: string | null
      year: number | null
      genre: string | null
      duration: number
      bitrate: number | null
      coverPath: string | null
      quality: string
      uploadedBy: {
        id: string
        username: string
        avatar: string | null
      }
    } | null,
  ) {
    if (!track) return null

    return {
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
  }

  private toClientLoopMode(mode: PlaybackLoopMode) {
    if (mode === PlaybackLoopMode.TRACK) return 'track'
    if (mode === PlaybackLoopMode.QUEUE) return 'queue'
    return 'none'
  }

  private resolvePlaybackMode(playbackMode?: string | null) {
    if (this.isDirectOnlyDeployment()) {
      return StationPlaybackMode.DIRECT
    }

    return playbackMode === StationPlaybackMode.BROADCAST
      ? StationPlaybackMode.BROADCAST
      : StationPlaybackMode.DIRECT
  }

  private isDirectOnlyDeployment() {
    const mode = this.configService.get<string>('APP_DEPLOYMENT_MODE')?.trim().toLowerCase()
    return mode === 'direct'
  }

  private getOnlineUserIds(stationId: string) {
    const userIds = new Set<string>()
    const socketIds = this.stationSockets.get(stationId)
    if (!socketIds) return userIds

    for (const socketId of socketIds) {
      const meta = this.socketMeta.get(socketId)
      if (meta?.userId) userIds.add(meta.userId)
    }

    return userIds
  }

  // Public method for broadcasting from background services.
  broadcastToStation(stationId: string, event: string, data: any) {
    this.server.to(stationId).emit(event, data)
  }
}
