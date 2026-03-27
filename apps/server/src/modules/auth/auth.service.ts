import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import * as bcrypt from 'bcryptjs'
import * as fs from 'fs'
import * as path from 'path'
import { v4 as uuid } from 'uuid'
import { USER_STORAGE_LIMIT_BYTES } from '@web-radio/shared'
import { PrismaService } from '../../prisma/prisma.service'
import { RegisterDto } from './dto/register.dto'
import { LoginDto } from './dto/login.dto'
import { UpdateMeDto } from './dto/update-me.dto'

type AuthUserPayload = {
  id: string
  email: string
  username: string
  avatar: string | null
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const email = this.normalizeEmail(dto.email)

    this.ensureEmailIsWhitelisted(email)

    const existingEmail = await this.prisma.user.findUnique({ where: { email } })
    if (existingEmail) throw new ConflictException('Email already in use')

    const existingUsername = await this.prisma.user.findUnique({ where: { username: dto.username } })
    if (existingUsername) throw new ConflictException('Username already taken')

    const passwordHash = await bcrypt.hash(dto.password, 12)

    const user = await this.prisma.user.create({
      data: { email, username: dto.username, passwordHash },
      select: {
        id: true,
        email: true,
        username: true,
        avatar: true,
      },
    })

    return this.generateTokens(user)
  }

  async login(dto: LoginDto) {
    const email = this.normalizeEmail(dto.email)
    const user = await this.prisma.user.findUnique({ where: { email } })
    if (!user) throw new UnauthorizedException('Invalid credentials')

    const isValid = await bcrypt.compare(dto.password, user.passwordHash)
    if (!isValid) throw new UnauthorizedException('Invalid credentials')

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastSeenAt: new Date() },
    })

    return this.generateTokens({
      id: user.id,
      email: user.email,
      username: user.username,
      avatar: user.avatar,
    })
  }

  async refresh(refreshToken: string) {
    const stored = await this.prisma.refreshToken.findUnique({ where: { token: refreshToken } })
    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token')
    }

    await this.prisma.refreshToken.delete({ where: { token: refreshToken } })

    const user = await this.prisma.user.findUnique({
      where: { id: stored.userId },
      select: {
        id: true,
        email: true,
        username: true,
        avatar: true,
      },
    })
    if (!user) throw new UnauthorizedException()

    return this.generateTokens(user)
  }

  async logout(refreshToken: string) {
    await this.prisma.refreshToken.deleteMany({ where: { token: refreshToken } })
  }

  async getMe(userId: string) {
    const [user, storage] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          username: true,
          avatar: true,
          createdAt: true,
          lastSeenAt: true,
        },
      }),
      this.getUserStorage(userId),
    ])
    if (!user) throw new UnauthorizedException()

    return {
      ...user,
      storage,
    }
  }

  async updateMe(userId: string, dto: UpdateMeDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, email: true },
    })
    if (!user) throw new UnauthorizedException()

    let username = user.username
    const requestedUsername = dto.username === null ? '' : dto.username?.trim()

    if (requestedUsername === '') {
      username = await this.generateUniqueUsername(user.email)
    } else if (requestedUsername && requestedUsername !== user.username) {
      const existing = await this.prisma.user.findUnique({ where: { username: requestedUsername } })
      if (existing) throw new ConflictException('Username already taken')
      username = requestedUsername
    }

    if (dto.avatar && dto.avatar.length > 400000) {
      throw new BadRequestException('Avatar is too large')
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        username,
        ...(dto.avatar !== undefined ? { avatar: dto.avatar || null } : {}),
      },
      select: {
        id: true,
        email: true,
        username: true,
        avatar: true,
        createdAt: true,
        lastSeenAt: true,
      },
    })

    const storage = await this.getUserStorage(userId)

    return {
      ...updated,
      storage,
    }
  }

  private async generateUniqueUsername(seed: string) {
    const safeSeed = (seed.split('@')[0] || 'pine')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 18)
    const base = safeSeed.length >= 3 ? safeSeed : 'pineuser'

    for (let i = 0; i < 24; i++) {
      const suffix = Math.random().toString(36).slice(2, 6)
      const candidate = `${base}_${suffix}`.slice(0, 30)
      const existing = await this.prisma.user.findUnique({ where: { username: candidate } })
      if (!existing) return candidate
    }

    throw new ConflictException('Failed to generate a unique username')
  }

  private async generateTokens(user: AuthUserPayload) {
    const payload = { sub: user.id, email: user.email, username: user.username }

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get('JWT_SECRET'),
      expiresIn: this.configService.get('JWT_ACCESS_EXPIRES', '15m'),
    })

    const refreshTokenValue = uuid()
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 7)

    await this.prisma.refreshToken.create({
      data: { token: refreshTokenValue, userId: user.id, expiresAt },
    })

    const storage = await this.getUserStorage(user.id)

    return {
      accessToken,
      refreshToken: refreshTokenValue,
      user: { ...user, storage },
    }
  }

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase()
  }

  private ensureEmailIsWhitelisted(email: string) {
    const allowedEmails = this.loadRegistrationWhitelist()
    if (!allowedEmails.size || !allowedEmails.has(email)) {
      throw new ForbiddenException('Registration is available only for whitelisted emails')
    }
  }

  private loadRegistrationWhitelist(): Set<string> {
    const whitelistPath = this.resolveWhitelistPath()
    if (!fs.existsSync(whitelistPath)) {
      return new Set()
    }

    try {
      const raw = fs.readFileSync(whitelistPath, 'utf8')
      const parsed = JSON.parse(raw) as { allowedEmails?: unknown }
      if (!Array.isArray(parsed.allowedEmails)) return new Set()

      return new Set(
        parsed.allowedEmails
          .filter((value): value is string => typeof value === 'string')
          .map((value) => this.normalizeEmail(value)),
      )
    } catch (_error) {
      throw new InternalServerErrorException('Failed to read registration whitelist')
    }
  }

  private resolveWhitelistPath() {
    const configuredPath = this.configService.get<string>('REGISTRATION_WHITELIST_PATH')?.trim()
    if (configuredPath) {
      return path.isAbsolute(configuredPath)
        ? configuredPath
        : path.resolve(process.cwd(), configuredPath)
    }

    const cwd = process.cwd()
    const defaultPath = path.resolve(cwd, 'config', 'registration-whitelist.json')
    if (fs.existsSync(defaultPath)) return defaultPath

    return path.resolve(cwd, 'apps/server/config/registration-whitelist.json')
  }

  private async getUserStorage(userId: string) {
    const usage = await this.prisma.track.aggregate({
      where: { uploadedById: userId },
      _sum: { fileSize: true },
    })

    const usedBytes = usage._sum.fileSize ?? 0
    const limitBytes = USER_STORAGE_LIMIT_BYTES

    return {
      usedBytes,
      limitBytes,
      availableBytes: Math.max(limitBytes - usedBytes, 0),
    }
  }
}
