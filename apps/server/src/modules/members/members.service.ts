import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { MemberRole, ROLE_PERMISSIONS, Permission } from '@web-radio/shared'

@Injectable()
export class MembersService {
  constructor(private prisma: PrismaService) {}

  async getMembers(stationId: string) {
    const members = await this.prisma.stationMember.findMany({
      where: { stationId },
      include: {
        user: { select: { id: true, username: true, avatar: true, lastSeenAt: true } },
      },
      orderBy: { joinedAt: 'asc' },
    })

    return members.map((m) => ({
      id: m.id,
      stationId: m.stationId,
      user: m.user,
      role: m.role,
      permissions: JSON.parse(m.permissions),
      joinedAt: m.joinedAt,
      isOnline: false,
    }))
  }

  async updateRole(
    stationId: string,
    targetUserId: string,
    requesterId: string,
    role: MemberRole,
  ) {
    // Verify requester has permission
    const requester = await this.prisma.stationMember.findUnique({
      where: { stationId_userId: { stationId, userId: requesterId } },
    })

    if (!requester) throw new ForbiddenException('Not a member')

    const roleHierarchy = [
      MemberRole.GUEST,
      MemberRole.LISTENER,
      MemberRole.DJ,
      MemberRole.MODERATOR,
      MemberRole.ADMIN,
      MemberRole.OWNER,
    ]

    const requesterLevel = roleHierarchy.indexOf(requester.role as MemberRole)
    const targetLevel = roleHierarchy.indexOf(role)

    if (requesterLevel <= targetLevel) {
      throw new ForbiddenException('Cannot assign role equal or higher than your own')
    }

    const member = await this.prisma.stationMember.findUnique({
      where: { stationId_userId: { stationId, userId: targetUserId } },
    })

    if (!member) throw new NotFoundException('Member not found')

    const defaultPermissions = ROLE_PERMISSIONS[role] ?? []

    return this.prisma.stationMember.update({
      where: { stationId_userId: { stationId, userId: targetUserId } },
      data: {
        role,
        permissions: JSON.stringify(defaultPermissions),
      },
      include: {
        user: { select: { id: true, username: true, avatar: true } },
      },
    })
  }

  async updatePermissions(
    stationId: string,
    targetUserId: string,
    requesterId: string,
    permissions: string[],
  ) {
    await this.assertCanManageMembers(stationId, requesterId)

    const member = await this.prisma.stationMember.findUnique({
      where: { stationId_userId: { stationId, userId: targetUserId } },
    })

    if (!member) throw new NotFoundException('Member not found')
    if (member.role === MemberRole.OWNER) throw new ForbiddenException('Cannot change owner permissions')

    return this.prisma.stationMember.update({
      where: { stationId_userId: { stationId, userId: targetUserId } },
      data: { permissions: JSON.stringify(permissions) },
    })
  }

  async kick(stationId: string, targetUserId: string, requesterId: string) {
    await this.assertCanManageMembers(stationId, requesterId)

    const station = await this.prisma.station.findUnique({ where: { id: stationId } })
    if (!station) throw new NotFoundException('Station not found')
    if (targetUserId === station.ownerId) throw new ForbiddenException('Cannot kick the owner')
    if (targetUserId === requesterId) throw new ForbiddenException('Cannot kick yourself')

    await this.prisma.stationMember.delete({
      where: { stationId_userId: { stationId, userId: targetUserId } },
    })
  }

  async getMemberRole(stationId: string, userId: string): Promise<MemberRole> {
    const member = await this.prisma.stationMember.findUnique({
      where: { stationId_userId: { stationId, userId } },
    })
    return (member?.role as MemberRole) ?? MemberRole.GUEST
  }

  async hasPermission(stationId: string, userId: string, permission: string): Promise<boolean> {
    const member = await this.prisma.stationMember.findUnique({
      where: { stationId_userId: { stationId, userId } },
    })
    if (!member) return false
    if (member.role === MemberRole.OWNER) return true

    const permissions = JSON.parse(member.permissions) as string[]
    return permissions.includes(permission)
  }

  private async assertCanManageMembers(stationId: string, requesterId: string) {
    const requester = await this.prisma.stationMember.findUnique({
      where: { stationId_userId: { stationId, userId: requesterId } },
    })
    if (!requester) throw new ForbiddenException('Not a member')
    if (requester.role === MemberRole.OWNER) return

    const permissions = JSON.parse(requester.permissions) as string[]
    if (!permissions.includes(Permission.MANAGE_MEMBERS)) {
      throw new ForbiddenException('No permission')
    }
  }
}
