import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { v4 as uuid } from 'uuid'
import { PrismaService } from '../../prisma/prisma.service'
import { MemberRole } from '@web-radio/shared'

@Injectable()
export class InvitesService {
  constructor(private prisma: PrismaService) {}

  async create(stationId: string, userId: string, maxUses?: number, expiresInHours?: number) {
    const token = uuid().replace(/-/g, '').substring(0, 12)
    let expiresAt: Date | undefined

    if (expiresInHours) {
      expiresAt = new Date()
      expiresAt.setHours(expiresAt.getHours() + expiresInHours)
    }

    return this.prisma.stationInvite.create({
      data: { stationId, token, createdById: userId, maxUses, expiresAt },
    })
  }

  async getByToken(token: string) {
    const invite = await this.prisma.stationInvite.findUnique({
      where: { token },
      include: {
        station: {
          select: { id: true, code: true, name: true, coverImage: true },
        },
      },
    })

    if (!invite) throw new NotFoundException('Invite not found')
    if (invite.expiresAt && invite.expiresAt < new Date()) {
      throw new BadRequestException('Invite has expired')
    }
    if (invite.maxUses && invite.usedCount >= invite.maxUses) {
      throw new BadRequestException('Invite has reached max uses')
    }

    return invite
  }

  async use(token: string, userId: string) {
    const invite = await this.getByToken(token)

    // Add as member if not already
    const existing = await this.prisma.stationMember.findUnique({
      where: {
        stationId_userId: { stationId: invite.stationId, userId },
      },
    })

    if (!existing) {
      await this.prisma.stationMember.create({
        data: {
          stationId: invite.stationId,
          userId,
          role: MemberRole.LISTENER,
          permissions: '[]',
        },
      })
    }

    await this.prisma.stationInvite.update({
      where: { token },
      data: { usedCount: { increment: 1 } },
    })

    return { stationId: invite.stationId, code: invite.station.code }
  }
}
