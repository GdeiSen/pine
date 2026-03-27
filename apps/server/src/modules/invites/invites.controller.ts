import { Controller, Post, Get, Param, Body, UseGuards } from '@nestjs/common'
import { InvitesService } from './invites.service'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'
import { CurrentUser } from '../../common/decorators/current-user.decorator'
import { IsOptional, IsNumber } from 'class-validator'

class CreateInviteDto {
  @IsOptional()
  @IsNumber()
  maxUses?: number

  @IsOptional()
  @IsNumber()
  expiresInHours?: number
}

@Controller()
export class InvitesController {
  constructor(private invitesService: InvitesService) {}

  @Post('stations/:stationId/invites')
  @UseGuards(JwtAuthGuard)
  create(
    @Param('stationId') stationId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: CreateInviteDto,
  ) {
    return this.invitesService.create(stationId, user.id, dto.maxUses, dto.expiresInHours)
  }

  @Get('invites/:token')
  getByToken(@Param('token') token: string) {
    return this.invitesService.getByToken(token)
  }

  @Post('invites/:token/use')
  @UseGuards(JwtAuthGuard)
  use(@Param('token') token: string, @CurrentUser() user: { id: string }) {
    return this.invitesService.use(token, user.id)
  }
}
