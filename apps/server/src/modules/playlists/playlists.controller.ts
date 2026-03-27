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
  ParseUUIDPipe,
} from '@nestjs/common'
import { PlaylistsService, CreatePlaylistDto } from './playlists.service'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'
import { CurrentUser } from '../../common/decorators/current-user.decorator'
import { TracksService } from '../tracks/tracks.service'
import { IsArray, IsInt, IsUUID, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

class ReorderPlaylistTrackItemDto {
  @IsUUID()
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
  getPlaylists(
    @Param('stationId', new ParseUUIDPipe()) stationId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.playlistsService.getStationPlaylists(stationId, user.id)
  }

  @Post('stations/:stationId/playlists')
  create(
    @Param('stationId', new ParseUUIDPipe()) stationId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: CreatePlaylistDto,
  ) {
    return this.playlistsService.create(stationId, user.id, dto)
  }

  @Put('playlists/:id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: { id: string },
    @Body('name') name: string,
  ) {
    return this.playlistsService.update(id, user.id, name)
  }

  @Delete('playlists/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: { id: string }) {
    return this.playlistsService.delete(id, user.id)
  }

  @Post('stations/:stationId/playlists/:playlistId/activate')
  activate(
    @Param('stationId', new ParseUUIDPipe()) stationId: string,
    @Param('playlistId', new ParseUUIDPipe()) playlistId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.playlistsService.activate(playlistId, stationId, user.id)
  }

  @Get('playlists/:id/tracks')
  getPlaylistTracks(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.tracksService.getPlaylistTracks(id, user.id)
  }

  @Put('playlists/:id/tracks/reorder')
  reorderTracks(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: { id: string },
    @Body() dto: ReorderPlaylistTracksDto,
  ) {
    return this.playlistsService.reorderTracks(id, user.id, dto.items)
  }
}
