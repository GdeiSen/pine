import { Module } from '@nestjs/common'
import { StationsService } from './stations.service'
import { StationsController } from './stations.controller'
import { StorageModule } from '../storage/storage.module'

@Module({
  imports: [StorageModule],
  providers: [StationsService],
  controllers: [StationsController],
  exports: [StationsService],
})
export class StationsModule {}
