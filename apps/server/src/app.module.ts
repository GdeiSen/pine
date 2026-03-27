import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ThrottlerModule } from '@nestjs/throttler'
import { PrismaModule } from './prisma/prisma.module'
import { AuthModule } from './modules/auth/auth.module'
import { UsersModule } from './modules/users/users.module'
import { StationsModule } from './modules/stations/stations.module'
import { PlaylistsModule } from './modules/playlists/playlists.module'
import { TracksModule } from './modules/tracks/tracks.module'
import { QueueModule } from './modules/queue/queue.module'
import { MembersModule } from './modules/members/members.module'
import { ChatModule } from './modules/chat/chat.module'
import { InvitesModule } from './modules/invites/invites.module'
import { GatewayModule } from './modules/gateway/gateway.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    AuthModule,
    UsersModule,
    StationsModule,
    PlaylistsModule,
    TracksModule,
    QueueModule,
    MembersModule,
    ChatModule,
    InvitesModule,
    GatewayModule,
  ],
})
export class AppModule {}
