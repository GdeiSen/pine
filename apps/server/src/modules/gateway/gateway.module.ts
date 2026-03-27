import { Module } from '@nestjs/common'
import { StationGateway } from './station.gateway'
import { QueueModule } from '../queue/queue.module'
import { ChatModule } from '../chat/chat.module'
import { MembersModule } from '../members/members.module'
import { StationsModule } from '../stations/stations.module'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [QueueModule, ChatModule, MembersModule, StationsModule, AuthModule],
  providers: [StationGateway],
  exports: [StationGateway],
})
export class GatewayModule {}
