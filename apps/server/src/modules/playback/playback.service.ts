import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common'
import {
  PlaybackCommandType,
  PlaybackEventType,
  PlaybackLoopMode,
  Prisma,
  PlaybackCommandType as PrismaPlaybackCommandType,
} from '@prisma/client'
import { PlaybackCommandType as SharedPlaybackCommandType } from '@web-radio/shared'
import { PrismaService } from '../../prisma/prisma.service'
import { CreatePlaybackCommandDto } from './dto/create-playback-command.dto'

@Injectable()
export class PlaybackService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueueCommand(stationId: string, dto: CreatePlaybackCommandDto, userId: string) {
    await this.assertStationMember(stationId, userId)

    const command = await this.prisma.$transaction(async (tx) => {
      const created = await tx.playbackCommand.create({
        data: {
          stationId,
          type: this.toPrismaCommandType(dto.type),
          payload: this.toPrismaPayload(dto.payload),
          createdById: userId,
        },
      })

      await tx.playbackEvent.create({
        data: {
          stationId,
          type: PlaybackEventType.COMMAND_RECEIVED,
          commandId: created.id,
          payload: this.toPrismaPayload({
            commandType: created.type,
            createdById: userId,
          }),
        },
      })

      return created
    })

    return {
      queued: true,
      command,
    }
  }

  async getPlaybackState(stationId: string, userId: string) {
    await this.assertStationMember(stationId, userId)
    return this.ensurePlaybackState(stationId)
  }

  private async ensurePlaybackState(stationId: string) {
    const station = await this.prisma.station.findUnique({
      where: { id: stationId },
      select: { id: true, systemQueueMode: true },
    })
    if (!station) throw new NotFoundException('Station not found')

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
        shuffleEnabled: station.systemQueueMode !== 'SEQUENTIAL',
        lastSyncedAt: new Date(),
      },
      update: {
        shuffleEnabled: station.systemQueueMode !== 'SEQUENTIAL',
      },
    })
  }

  private toPrismaPayload(
    payload: unknown,
  ): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
    if (payload === undefined) return undefined
    if (payload === null) return Prisma.JsonNull
    return payload as Prisma.InputJsonValue
  }

  private toPrismaCommandType(type: SharedPlaybackCommandType): PlaybackCommandType {
    switch (type) {
      case SharedPlaybackCommandType.PLAY:
        return PrismaPlaybackCommandType.PLAY
      case SharedPlaybackCommandType.PAUSE:
        return PrismaPlaybackCommandType.PAUSE
      case SharedPlaybackCommandType.PREVIOUS:
        return PrismaPlaybackCommandType.PREVIOUS
      case SharedPlaybackCommandType.SEEK:
        return PrismaPlaybackCommandType.SEEK
      case SharedPlaybackCommandType.SKIP:
        return PrismaPlaybackCommandType.SKIP
      case SharedPlaybackCommandType.SET_LOOP:
        return PrismaPlaybackCommandType.SET_LOOP
      case SharedPlaybackCommandType.SET_SHUFFLE:
        return PrismaPlaybackCommandType.SET_SHUFFLE
      case SharedPlaybackCommandType.QUEUE_ADD:
        return PrismaPlaybackCommandType.QUEUE_ADD
      case SharedPlaybackCommandType.QUEUE_REMOVE:
        return PrismaPlaybackCommandType.QUEUE_REMOVE
      case SharedPlaybackCommandType.QUEUE_REORDER:
        return PrismaPlaybackCommandType.QUEUE_REORDER
      default:
        throw new BadRequestException(`Unsupported playback command type: ${type}`)
    }
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
}
