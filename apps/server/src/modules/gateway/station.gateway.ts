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
import { PrismaService } from '../../prisma/prisma.service'
import { QueueService } from '../queue/queue.service'
import { ChatService } from '../chat/chat.service'
import { MembersService } from '../members/members.service'
import { StationsService } from '../stations/stations.service'
import {
  WS_EVENTS,
  ChatMessageType,
  MemberRole,
  Permission,
  PLAYBACK_SYNC_INTERVAL_MS,
  SystemQueueMode,
} from '@web-radio/shared'
import { isAllowedOrigin, resolveAllowedOrigins } from '../../common/security/cors'

interface AuthSocket extends Socket {
  userId?: string
  username?: string
  stationId?: string
}

interface PlaybackState {
  currentTrackId: string | null
  currentQueueItemId: string | null
  currentQueueType: 'USER' | 'SYSTEM' | null
  currentTrackDuration: number
  trackStartedAt: number | null
  isPaused: boolean
  pausedPosition: number
  position: number
  loopMode: 'none' | 'track' | 'queue'
  shuffleEnabled: boolean
  history: Array<{ trackId: string; queueItemId: string }>
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
  // Map: stationId → playback state
  private playbackStates = new Map<string, PlaybackState>()
  // Sync intervals
  private syncIntervals = new Map<string, NodeJS.Timeout>()
  // Track-end timers for automatic autoplay advance
  private trackEndTimers = new Map<string, NodeJS.Timeout>()
  // Sequential lock per station for playback mutations
  private playbackLocks = new Map<string, Promise<unknown>>()

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    private prisma: PrismaService,
    private queueService: QueueService,
    private chatService: ChatService,
    private membersService: MembersService,
    private stationsService: StationsService,
  ) {}

  afterInit() {
    this.logger.log('WebSocket Gateway initialized')
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
      // Anonymous connection
    }
  }

  async handleDisconnect(client: AuthSocket) {
    const meta = this.socketMeta.get(client.id)
    if (!meta) return

    const { stationId, userId } = meta
    this.socketMeta.delete(client.id)

    const sockets = this.stationSockets.get(stationId)
    if (sockets) {
      sockets.delete(client.id)
      if (sockets.size === 0) {
        this.stationSockets.delete(stationId)
        this.stopSyncInterval(stationId)
      }
    }

    // Notify other listeners
    this.server.to(stationId).emit(WS_EVENTS.LISTENER_LEFT, {
      userId,
      username: client.username,
      listenerCount: this.stationSockets.get(stationId)?.size ?? 0,
    })

    // System chat message
    if (client.username) {
      const msg = await this.chatService.createSystemMessage(
        stationId,
        `${client.username} left the station`,
        ChatMessageType.USER_LEFT,
      )
      this.server.to(stationId).emit(WS_EVENTS.CHAT_MESSAGE, msg)
    }
  }

  @SubscribeMessage(WS_EVENTS.STATION_JOIN)
  async handleJoin(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() data: { code: string; password?: string },
  ) {
    if (!client.userId) throw new WsException('Authentication required')
    if (!/^\d{6}$/.test(data.code)) throw new WsException('Invalid station code')

    try {
      await this.stationsService.join(data.code, client.userId, data.password)
    } catch (err: any) {
      throw new WsException(err?.message ?? 'Failed to join station')
    }

    const station = await this.prisma.station.findUnique({ where: { code: data.code } })
    if (!station) throw new WsException('Station not found')

    // Join socket room
    await client.join(station.id)
    client.stationId = station.id

    this.socketMeta.set(client.id, { userId: client.userId, stationId: station.id })

    if (!this.stationSockets.has(station.id)) {
      this.stationSockets.set(station.id, new Set())
    }
    this.stationSockets.get(station.id)!.add(client.id)

    // Set station live
    await this.stationsService.setLive(station.id, true)

    // Start sync interval if not already running
    if (!this.syncIntervals.has(station.id)) {
      this.startSyncInterval(station.id)
    }

    const member = await this.prisma.stationMember.findUnique({
      where: { stationId_userId: { stationId: station.id, userId: client.userId } },
      include: { user: { select: { id: true, username: true, avatar: true } } },
    })

    // Send full state to new client
    const state = await this.buildStationState(station.id)
    client.emit(WS_EVENTS.STATION_STATE, state)

    // Notify others
    this.server.to(station.id).except(client.id).emit(WS_EVENTS.LISTENER_JOINED, {
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

    // System chat message
    const msg = await this.chatService.createSystemMessage(
      station.id,
      `${client.username ?? 'Anonymous'} joined the station`,
      ChatMessageType.USER_JOINED,
    )
    this.server.to(station.id).emit(WS_EVENTS.CHAT_MESSAGE, msg)

    return { success: true, stationId: station.id }
  }

  @SubscribeMessage(WS_EVENTS.STATION_LEAVE)
  async handleLeave(@ConnectedSocket() client: AuthSocket) {
    if (!client.stationId) return
    await client.leave(client.stationId)
    await this.handleDisconnect(client)
  }

  @SubscribeMessage(WS_EVENTS.PLAYBACK_CONTROL)
  async handlePlaybackControl(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() data: { action: string; position?: number; value?: string },
  ) {
    if (!client.userId || !client.stationId) throw new WsException('Not in a station')

    const hasPermission = await this.membersService.hasPermission(
      client.stationId,
      client.userId,
      Permission.PLAYBACK_CONTROL,
    )
    if (!hasPermission) throw new WsException('No permission')
    const stationId = client.stationId

    await this.withPlaybackLock(stationId, async () => {
      const state = this.getOrCreatePlaybackState(stationId)

      switch (data.action) {
        case 'play':
          if (!state.currentTrackId) {
            await this.handleSkipUnsafe(stationId)
            return
          }
          state.isPaused = false
          state.trackStartedAt = Date.now() - state.pausedPosition * 1000
          this.scheduleTrackEnd(stationId)
          await this.prisma.station.update({
            where: { id: stationId },
            data: {
              isPaused: false,
              currentPosition: state.pausedPosition,
              trackStartedAt: new Date(state.trackStartedAt),
            },
          })
          break

        case 'pause':
          state.pausedPosition = this.getPlaybackPosition(state)
          state.isPaused = true
          state.trackStartedAt = null
          this.clearTrackEndTimer(stationId)
          await this.prisma.station.update({
            where: { id: stationId },
            data: {
              isPaused: true,
              pausedPosition: state.pausedPosition,
              currentPosition: state.pausedPosition,
              trackStartedAt: null,
            },
          })
          break

        case 'seek':
          if (data.position !== undefined) {
            const nextPosition = Math.max(0, data.position)
            state.pausedPosition = nextPosition
            if (state.isPaused) {
              state.trackStartedAt = null
              this.clearTrackEndTimer(stationId)
            } else {
              state.trackStartedAt = Date.now() - nextPosition * 1000
              this.scheduleTrackEnd(stationId)
            }
            await this.prisma.station.update({
              where: { id: stationId },
              data: {
                currentPosition: nextPosition,
                pausedPosition: nextPosition,
                isPaused: state.isPaused,
                trackStartedAt: state.trackStartedAt ? new Date(state.trackStartedAt) : null,
              },
            })
          }
          break

        case 'prev': {
          const currentPos = this.getPlaybackPosition(state)

          if (state.history.length > 0 && currentPos <= 3) {
            // Return the current playing item back to queue as pending,
            // so it is not lost when going back to previous.
            if (state.currentQueueItemId) {
              await this.queueService.requeuePlayingItem(state.currentQueueItemId)
            }

            // Go to previous track
            const prev = state.history.pop()!
            await this.playTrack(client.stationId!, prev.trackId, prev.queueItemId, false)
            return
          }

          // Fallback for server restart cases:
          // if in-memory history is empty and user queue has no pending items,
          // try to go back within the system queue using the latest played SYSTEM item.
          if (state.history.length === 0 && currentPos <= 3) {
            const hasUserPending = await this.queueService.hasPendingUserQueue(stationId)
            if (!hasUserPending) {
              const previousSystem = await this.queueService.getPreviousSystemTrack(stationId)
              if (previousSystem) {
                if (state.currentQueueItemId) {
                  await this.queueService.requeuePlayingItem(state.currentQueueItemId)
                }
                await this.playTrack(
                  stationId,
                  previousSystem.trackId,
                  previousSystem.queueItemId,
                  false,
                )
                return
              }
            }
          }

          // Restart current track from 0 — emit TRACK_CHANGED to force client Howl reload
          if (state.currentTrackId) {
            const track = await this.prisma.track.findUnique({
              where: { id: state.currentTrackId },
              include: { uploadedBy: { select: { id: true, username: true, avatar: true } } },
            })
            if (track) {
              state.trackStartedAt = Date.now()
              state.isPaused = false
              state.pausedPosition = 0
              state.currentTrackDuration = track.duration ?? 0
              this.scheduleTrackEnd(stationId)
              await this.prisma.station.update({
                where: { id: stationId },
                data: { currentPosition: 0, trackStartedAt: new Date(), isPaused: false },
              })
              const queue = await this.queueService.getQueue(stationId)
              this.server.to(stationId).emit(WS_EVENTS.TRACK_CHANGED, {
                track: {
                  id: track.id, title: track.title, artist: track.artist,
                  album: track.album, year: track.year, genre: track.genre,
                  duration: track.duration, hasCover: !!track.coverPath,
                  quality: track.quality, uploadedBy: track.uploadedBy,
                },
                trackStartedAt: state.trackStartedAt,
                currentQueueType: state.currentQueueType,
                queue,
              })
              return
            }
          }
          break
        }

        case 'set_loop':
          if (data.value === 'none' || data.value === 'track' || data.value === 'queue') {
            state.loopMode = data.value
          }
          break

        case 'set_shuffle':
          state.shuffleEnabled = !state.shuffleEnabled
          await this.prisma.station.update({
            where: { id: stationId },
            data: {
              systemQueueMode: state.shuffleEnabled
                ? SystemQueueMode.SHUFFLE
                : SystemQueueMode.SEQUENTIAL,
            },
          })
          await this.queueService.rebuildSystemQueue(stationId)
          this.server.to(stationId).emit(WS_EVENTS.QUEUE_UPDATED, {
            queue: await this.queueService.getQueue(stationId),
          })
          break

        case 'skip':
          await this.handleSkipUnsafe(stationId)
          return
      }

      this.emitPlaybackSync(stationId, state)
    })
  }

  @SubscribeMessage(WS_EVENTS.QUEUE_ADD)
  async handleQueueAdd(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody()
    data: { trackId: string; mode?: 'end' | 'next' | 'now'; beforeItemId?: string },
  ) {
    if (!client.userId || !client.stationId) throw new WsException('Not in a station')

    const hasPermission = await this.membersService.hasPermission(
      client.stationId,
      client.userId,
      Permission.ADD_TO_QUEUE,
    )
    if (!hasPermission) throw new WsException('No permission')

    await this.queueService.addToQueue(client.stationId, data.trackId, client.userId, {
      mode: data.mode,
      beforeItemId: data.beforeItemId,
    })
    const queue = await this.queueService.getQueue(client.stationId)

    this.server.to(client.stationId).emit(WS_EVENTS.QUEUE_UPDATED, { queue })

    // System message
    const track = await this.prisma.track.findUnique({ where: { id: data.trackId } })
    if (track) {
      const msg = await this.chatService.createSystemMessage(
        client.stationId,
        `${client.username} added "${track.title ?? track.filename}" to queue`,
        ChatMessageType.TRACK_ADDED,
        { trackId: data.trackId, addedBy: client.username },
      )
      this.server.to(client.stationId).emit(WS_EVENTS.CHAT_MESSAGE, msg)
    }

    // Force immediate play if requested; otherwise start only when idle
    if (data.mode === 'now') {
      await this.handleSkip(client.stationId)
    } else if (!this.getOrCreatePlaybackState(client.stationId).currentTrackId) {
      await this.handleSkip(client.stationId)
    }
  }

  @SubscribeMessage(WS_EVENTS.QUEUE_REORDER)
  async handleQueueReorder(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() data: { items: Array<{ id: string; position: number }> },
  ) {
    if (!client.userId || !client.stationId) throw new WsException('Not in a station')

    const hasPermission = await this.membersService.hasPermission(
      client.stationId,
      client.userId,
      Permission.REORDER_QUEUE,
    )
    if (!hasPermission) throw new WsException('No permission')

    const queue = await this.queueService.reorderQueue(client.stationId, data.items)
    this.server.to(client.stationId).emit(WS_EVENTS.QUEUE_UPDATED, { queue })
  }

  @SubscribeMessage(WS_EVENTS.QUEUE_SKIP)
  async handleQueueSkip(@ConnectedSocket() client: AuthSocket) {
    if (!client.userId || !client.stationId) throw new WsException('Not in a station')

    const hasPermission = await this.membersService.hasPermission(
      client.stationId,
      client.userId,
      Permission.SKIP_TRACK,
    )
    if (!hasPermission) throw new WsException('No permission')

    await this.handleSkip(client.stationId)
  }

  @SubscribeMessage(WS_EVENTS.TRACK_ENDED)
  async handleTrackEnded(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() data: { trackId?: string },
  ) {
    // Server is the only authoritative source for track-end transitions.
    // Ignore client-originated track-ended messages to prevent race conditions.
    void data
    if (!client.stationId) return
  }

  @SubscribeMessage(WS_EVENTS.QUEUE_REMOVE)
  async handleQueueRemove(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() data: { itemId: string },
  ) {
    if (!client.userId || !client.stationId) throw new WsException('Not in a station')

    const item = await this.prisma.queueItem.findUnique({
      where: { id: data.itemId },
      select: { stationId: true, addedById: true },
    })
    if (!item || item.stationId !== client.stationId) {
      throw new WsException('Queue item not found')
    }

    const canRemove = await this.membersService.hasPermission(
      client.stationId,
      client.userId,
      Permission.REMOVE_FROM_QUEUE,
    )
    const canReorder = await this.membersService.hasPermission(
      client.stationId,
      client.userId,
      Permission.REORDER_QUEUE,
    )
    const canAdd = await this.membersService.hasPermission(
      client.stationId,
      client.userId,
      Permission.ADD_TO_QUEUE,
    )
    const isOwnItem = item.addedById === client.userId
    if (!canRemove && !canReorder && !canAdd && !isOwnItem) throw new WsException('No permission')

    await this.queueService.removeFromQueue(client.stationId, data.itemId)
    this.server.to(client.stationId).emit(WS_EVENTS.QUEUE_UPDATED, {
      queue: await this.queueService.getQueue(client.stationId),
    })
  }

  @SubscribeMessage(WS_EVENTS.CHAT_SEND)
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
    this.server.to(client.stationId).emit(WS_EVENTS.CHAT_MESSAGE, msg)
  }

  @SubscribeMessage(WS_EVENTS.HEARTBEAT)
  handleHeartbeat(@ConnectedSocket() client: AuthSocket) {
    if (client.userId) {
      this.prisma.user.update({
        where: { id: client.userId },
        data: { lastSeenAt: new Date() },
      }).catch(() => {})
    }
    return { ok: true }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────────

  private withPlaybackLock<T>(stationId: string, task: () => Promise<T>) {
    const previous = this.playbackLocks.get(stationId) ?? Promise.resolve()
    let current: Promise<T>
    current = previous
      .catch(() => undefined)
      .then(() => task())
      .finally(() => {
        if (this.playbackLocks.get(stationId) === current) {
          this.playbackLocks.delete(stationId)
        }
      })

    this.playbackLocks.set(stationId, current)
    return current
  }

  private getPlaybackPosition(state: PlaybackState) {
    if (state.isPaused) return Math.max(0, state.pausedPosition)
    if (!state.trackStartedAt) return Math.max(0, state.pausedPosition)
    return Math.max(0, (Date.now() - state.trackStartedAt) / 1000)
  }

  private emitPlaybackSync(stationId: string, state: PlaybackState) {
    this.server.to(stationId).emit(WS_EVENTS.PLAYBACK_SYNC, {
      currentTrackId: state.currentTrackId,
      currentQueueType: state.currentQueueType,
      position: this.getPlaybackPosition(state),
      isPaused: state.isPaused,
      trackStartedAt: state.trackStartedAt,
      loopMode: state.loopMode,
      shuffleEnabled: state.shuffleEnabled,
    })
  }

  private async handleSkip(stationId: string) {
    await this.withPlaybackLock(stationId, () => this.handleSkipUnsafe(stationId))
  }

  private async handleSkipUnsafe(stationId: string) {
    const state = this.getOrCreatePlaybackState(stationId)
    this.clearTrackEndTimer(stationId)

    // Loop track: restart current instead of advancing
    if (state.loopMode === 'track' && state.currentTrackId && state.currentQueueItemId) {
      state.trackStartedAt = Date.now()
      state.pausedPosition = 0
      this.scheduleTrackEnd(stationId)
      this.emitPlaybackSync(stationId, state)
      return
    }

    // Mark current item as played (history is saved in playTrack)
    if (state.currentQueueItemId) {
      await this.queueService.markPlayed(state.currentQueueItemId)
    }

    // Get next track
    const next = await this.queueService.getNextTrack(stationId)

    if (!next) {
      // Rebuild system queue if empty
      await this.queueService.rebuildSystemQueue(stationId)
      const retryNext = await this.queueService.getNextTrack(stationId)

      if (!retryNext) {
        // Nothing to play
        state.currentTrackId = null
        state.currentQueueItemId = null
        state.currentQueueType = null
        state.currentTrackDuration = 0
        state.trackStartedAt = null
        state.isPaused = false

        await this.prisma.station.update({
          where: { id: stationId },
          data: { currentTrackId: null, currentPosition: 0 },
        })

        this.server.to(stationId).emit(WS_EVENTS.TRACK_CHANGED, { track: null })
        return
      }

      await this.playTrack(stationId, retryNext.trackId, retryNext.queueItemId)
    } else {
      await this.playTrack(stationId, next.trackId, next.queueItemId)
    }
  }

  private async playTrack(stationId: string, trackId: string, queueItemId: string, addToHistory = true) {
    const state = this.getOrCreatePlaybackState(stationId)
    const queueItem = await this.prisma.queueItem.findUnique({
      where: { id: queueItemId },
      select: { queueType: true },
    })
    const track = await this.prisma.track.findUnique({
      where: { id: trackId },
      include: {
        uploadedBy: { select: { id: true, username: true, avatar: true } },
      },
    })

    if (!track) return

    await this.queueService.markPlaying(queueItemId)

    // Save current to history before switching (unless called from prev)
    if (addToHistory && state.currentTrackId && state.currentQueueItemId) {
      state.history.push({ trackId: state.currentTrackId, queueItemId: state.currentQueueItemId })
      if (state.history.length > 50) state.history.shift()
    }

    state.currentTrackId = trackId
    state.currentQueueItemId = queueItemId
    state.currentQueueType = (queueItem?.queueType as 'USER' | 'SYSTEM' | undefined) ?? null
    state.currentTrackDuration = track.duration ?? 0
    state.trackStartedAt = Date.now()
    state.isPaused = false
    state.pausedPosition = 0
    this.scheduleTrackEnd(stationId)

    await this.prisma.station.update({
      where: { id: stationId },
      data: {
        currentTrackId: trackId,
        currentPosition: 0,
        trackStartedAt: new Date(),
        isPaused: false,
      },
    })

    const queue = await this.queueService.getQueue(stationId)

    this.server.to(stationId).emit(WS_EVENTS.TRACK_CHANGED, {
      track: {
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
      },
      trackStartedAt: state.trackStartedAt,
      currentQueueType: state.currentQueueType,
      queue,
    })
  }

  private startSyncInterval(stationId: string) {
    const interval = setInterval(async () => {
      const state = this.playbackStates.get(stationId)
      if (!state || !state.currentTrackId) return

      this.emitPlaybackSync(stationId, state)
    }, PLAYBACK_SYNC_INTERVAL_MS)

    this.syncIntervals.set(stationId, interval)
  }

  private stopSyncInterval(stationId: string) {
    const interval = this.syncIntervals.get(stationId)
    if (interval) {
      clearInterval(interval)
      this.syncIntervals.delete(stationId)
    }
  }

  private getOrCreatePlaybackState(stationId: string): PlaybackState {
    if (!this.playbackStates.has(stationId)) {
      this.playbackStates.set(stationId, {
        currentTrackId: null,
        currentQueueItemId: null,
        currentQueueType: null,
        currentTrackDuration: 0,
        trackStartedAt: null,
        isPaused: false,
        pausedPosition: 0,
        position: 0,
        loopMode: 'none',
        shuffleEnabled: false,
        history: [],
      })
    }
    return this.playbackStates.get(stationId)!
  }

  private clearTrackEndTimer(stationId: string) {
    const timer = this.trackEndTimers.get(stationId)
    if (timer) {
      clearTimeout(timer)
      this.trackEndTimers.delete(stationId)
    }
  }

  private scheduleTrackEnd(stationId: string) {
    const state = this.getOrCreatePlaybackState(stationId)
    this.clearTrackEndTimer(stationId)

    if (state.isPaused || !state.currentTrackId || state.currentTrackDuration <= 0) return

    const position = state.trackStartedAt
      ? (Date.now() - state.trackStartedAt) / 1000
      : state.pausedPosition
    const remainingMs = Math.max(0, (state.currentTrackDuration - position) * 1000)

    const timer = setTimeout(async () => {
      this.trackEndTimers.delete(stationId)
      const latest = this.playbackStates.get(stationId)
      if (!latest || latest.isPaused || !latest.currentTrackId) return
      await this.handleSkip(stationId)
    }, remainingMs + 120)

    this.trackEndTimers.set(stationId, timer)
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
    if (!station) return null

    const queue = await this.queueService.getQueue(stationId)
    const onlineUserIds = this.getOnlineUserIds(stationId)
    const members = await this.prisma.stationMember.findMany({
      where: { stationId },
      include: { user: { select: { id: true, username: true, avatar: true } } },
      orderBy: { joinedAt: 'asc' },
    })
    const state = this.getOrCreatePlaybackState(stationId)
    state.shuffleEnabled = station.systemQueueMode !== SystemQueueMode.SEQUENTIAL

    let currentTrack = null
    if (state.currentTrackId) {
      currentTrack = await this.prisma.track.findUnique({
        where: { id: state.currentTrackId },
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
        activePlaylistId: station.activePlaylistId,
        listenerCount: this.stationSockets.get(stationId)?.size ?? 0,
      },
      currentTrack,
      currentPosition: this.getPlaybackPosition(state),
      isPaused: state.isPaused,
      trackStartedAt: state.trackStartedAt,
      currentQueueType: state.currentQueueType,
      loopMode: state.loopMode,
      shuffleEnabled: state.shuffleEnabled,
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

  // Public method for broadcasting from HTTP controllers
  broadcastToStation(stationId: string, event: string, data: any) {
    this.server.to(stationId).emit(event, data)
  }
}
