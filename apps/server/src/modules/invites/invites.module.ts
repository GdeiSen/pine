import { Module } from '@nestjs/common'
import { InvitesService } from './invites.service'
import { InvitesController } from './invites.controller'

@Module({
  providers: [InvitesService],
  controllers: [InvitesController],
  exports: [InvitesService],
})
export class InvitesModule {}
