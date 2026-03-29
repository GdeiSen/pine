import { Module } from '@nestjs/common'
import { PlaylistsService } from './playlists.service'
import { PlaylistsController } from './playlists.controller'
import { TracksModule } from '../tracks/tracks.module'
import { QueueModule } from '../queue/queue.module'
import { StorageModule } from '../storage/storage.module'

@Module({
  imports: [TracksModule, QueueModule, StorageModule],
  providers: [PlaylistsService],
  controllers: [PlaylistsController],
  exports: [PlaylistsService],
})
export class PlaylistsModule {}
