import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import { PlaylistsService, CreatePlaylistDto } from './playlists.service'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'
import { CurrentUser } from '../../common/decorators/current-user.decorator'
import { TracksService } from '../tracks/tracks.service'
import { IsArray, IsInt, IsString, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

class ReorderPlaylistTrackItemDto {
  @IsString()
  trackId: string

  @IsInt()
  sortOrder: number
}

class ReorderPlaylistTracksDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderPlaylistTrackItemDto)
  items: ReorderPlaylistTrackItemDto[]
}

@Controller()
@UseGuards(JwtAuthGuard)
export class PlaylistsController {
  constructor(
    private playlistsService: PlaylistsService,
    private tracksService: TracksService,
  ) {}

  @Get('stations/:stationId/playlists')
  getPlaylists(@Param('stationId') stationId: string) {
    return this.playlistsService.getStationPlaylists(stationId)
  }

  @Post('stations/:stationId/playlists')
  create(
    @Param('stationId') stationId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: CreatePlaylistDto,
  ) {
    return this.playlistsService.create(stationId, user.id, dto)
  }

  @Put('playlists/:id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
    @Body('name') name: string,
  ) {
    return this.playlistsService.update(id, user.id, name)
  }

  @Delete('playlists/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.playlistsService.delete(id, user.id)
  }

  @Post('stations/:stationId/playlists/:playlistId/activate')
  activate(
    @Param('stationId') stationId: string,
    @Param('playlistId') playlistId: string,
  ) {
    return this.playlistsService.activate(playlistId, stationId)
  }

  @Get('playlists/:id/tracks')
  getPlaylistTracks(@Param('id') id: string) {
    return this.tracksService.getPlaylistTracks(id)
  }

  @Put('playlists/:id/tracks/reorder')
  reorderTracks(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
    @Body() dto: ReorderPlaylistTracksDto,
  ) {
    return this.playlistsService.reorderTracks(id, user.id, dto.items)
  }
}
