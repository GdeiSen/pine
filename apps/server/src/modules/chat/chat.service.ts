import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { ChatMessageType, CHAT_PAGE_SIZE } from '@web-radio/shared'

@Injectable()
export class ChatService {
  constructor(private prisma: PrismaService) {}

  async getMessages(stationId: string, cursor?: string) {
    const messages = await this.prisma.chatMessage.findMany({
      where: { stationId },
      include: {
        user: { select: { id: true, username: true, avatar: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: CHAT_PAGE_SIZE,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    })

    return messages.reverse().map(this.formatMessage)
  }

  async createMessage(
    stationId: string,
    userId: string,
    content: string,
    type: ChatMessageType = ChatMessageType.TEXT,
    metadata?: Record<string, any>,
  ) {
    const message = await this.prisma.chatMessage.create({
      data: {
        stationId,
        userId,
        content,
        type,
        metadata: metadata ? JSON.stringify(metadata) : null,
      },
      include: {
        user: { select: { id: true, username: true, avatar: true } },
      },
    })

    return this.formatMessage(message)
  }

  async createSystemMessage(
    stationId: string,
    content: string,
    type: ChatMessageType = ChatMessageType.SYSTEM,
    metadata?: Record<string, any>,
  ) {
    const message = await this.prisma.chatMessage.create({
      data: {
        stationId,
        content,
        type,
        metadata: metadata ? JSON.stringify(metadata) : null,
      },
      include: {
        user: { select: { id: true, username: true, avatar: true } },
      },
    })

    return this.formatMessage(message)
  }

  private formatMessage(message: any) {
    return {
      id: message.id,
      stationId: message.stationId,
      user: message.user,
      content: message.content,
      type: message.type,
      metadata: message.metadata ? JSON.parse(message.metadata) : null,
      createdAt: message.createdAt,
    }
  }
}
