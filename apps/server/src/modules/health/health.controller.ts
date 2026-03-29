import { Controller, Get, ServiceUnavailableException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  liveness() {
    return {
      status: 'ok',
      now: new Date().toISOString(),
    }
  }

  @Get('live')
  live() {
    return this.liveness()
  }

  @Get('ready')
  async readiness() {
    try {
      await this.prisma.$queryRaw`SELECT 1`
    } catch {
      throw new ServiceUnavailableException('Database is not ready')
    }

    return {
      status: 'ready',
      now: new Date().toISOString(),
    }
  }
}
