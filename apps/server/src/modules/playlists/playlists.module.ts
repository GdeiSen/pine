import { Module } from '@nestjs/common'
import { PlaylistsService } from './playlists.service'
import { PlaylistsController } from './playlists.controller'
import { TracksModule } from '../tracks/tracks.module'
import { QueueModule } from '../queue/queue.module'

@Module({
  imports: [TracksModule, QueueModule],
  providers: [PlaylistsService],
  controllers: [PlaylistsController],
  exports: [PlaylistsService],
})
export class PlaylistsModule {}
