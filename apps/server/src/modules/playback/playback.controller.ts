import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common'
import { PlaybackService } from './playback.service'
import { CreatePlaybackCommandDto } from './dto/create-playback-command.dto'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'
import { CurrentUser } from '../../common/decorators/current-user.decorator'

@Controller('stations/:stationId/playback')
@UseGuards(JwtAuthGuard)
export class PlaybackController {
  constructor(private readonly playbackService: PlaybackService) {}

  @Post('commands')
  enqueueCommand(
    @Param('stationId', new ParseUUIDPipe()) stationId: string,
    @Body() dto: CreatePlaybackCommandDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.playbackService.enqueueCommand(stationId, dto, user.id)
  }

  @Get('state')
  getPlaybackState(
    @Param('stationId', new ParseUUIDPipe()) stationId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.playbackService.getPlaybackState(stationId, user.id)
  }
}
