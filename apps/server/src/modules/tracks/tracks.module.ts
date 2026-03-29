import { Module } from '@nestjs/common'
import { TracksService } from './tracks.service'
import { TracksController } from './tracks.controller'
import { StorageModule } from '../storage/storage.module'

@Module({
  imports: [StorageModule],
  providers: [TracksService],
  controllers: [TracksController],
  exports: [TracksService],
})
export class TracksModule {}
