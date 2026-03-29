import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { ConfigService } from '@nestjs/config'
import { Request } from 'express'
import { PrismaService } from '../../../prisma/prisma.service'

export interface JwtPayload {
  sub: string
  email: string
  username: string
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private prisma: PrismaService,
    configService: ConfigService,
  ) {
    const extractFromCookie = (req: Request): string | null => {
      const token = req?.cookies?.['access_token']
      return typeof token === 'string' && token.trim().length > 0 ? token : null
    }

    const extractFromQuery = (req: Request): string | null => {
      const raw = req?.query?.access_token
      if (typeof raw === 'string' && raw.trim().length > 0) return raw
      return null
    }

    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        extractFromCookie,
        extractFromQuery,
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET') as string,
    })
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } })
    if (!user) throw new UnauthorizedException()
    return { id: user.id, email: user.email, username: user.username }
  }
}
