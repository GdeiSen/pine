import { Module } from '@nestjs/common'
import { PrismaModule } from '../../prisma/prisma.module'
import { GatewayModule } from '../gateway/gateway.module'
import { PlaybackController } from './playback.controller'
import { PlaybackEventsService } from './playback.events.service'
import { PlaybackService } from './playback.service'

@Module({
  imports: [PrismaModule, GatewayModule],
  controllers: [PlaybackController],
  providers: [PlaybackService, PlaybackEventsService],
  exports: [PlaybackService, PlaybackEventsService],
})
export class PlaybackModule {}
