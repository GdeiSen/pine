import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Param,
  Body,
  Query,
  Headers,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ParseUUIDPipe,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { SkipThrottle } from '@nestjs/throttler'
import { diskStorage } from 'multer'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { v4 as uuid } from 'uuid'
import { Response } from 'express'
import { TracksService } from './tracks.service'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'
import { OptionalJwtGuard } from '../../common/guards/optional-jwt.guard'
import { CurrentUser } from '../../common/decorators/current-user.decorator'
import {
  SUPPORTED_AUDIO_FORMATS,
  SUPPORTED_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
} from '@web-radio/shared'

@Controller()
export class TracksController {
  constructor(private tracksService: TracksService) {}

  @Post('stations/:stationId/tracks/upload')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req: any, _file, cb) => {
          const dir = path.join(os.tmpdir(), 'pine-uploads')
          fs.mkdirSync(dir, { recursive: true })
          cb(null, dir)
        },
        filename: (_req, file, cb) => {
          const ext = path.extname(file.originalname).toLowerCase()
          const extension = SUPPORTED_EXTENSIONS.includes(ext) ? ext : '.mp3'
          cb(null, `${uuid()}${extension}`)
        },
      }),
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase()
        const normalizedMime = String(file.mimetype ?? '').toLowerCase()
        const isMimeAllowed = SUPPORTED_AUDIO_FORMATS.includes(normalizedMime)
        const isFallbackMime =
          normalizedMime.length === 0 ||
          normalizedMime === 'application/octet-stream' ||
          normalizedMime === 'binary/octet-stream'
        const isAudioMime = normalizedMime.startsWith('audio/')
        const isExtAllowed = SUPPORTED_EXTENSIONS.includes(ext)
        if (isExtAllowed && (isMimeAllowed || isAudioMime || isFallbackMime)) cb(null, true)
        else cb(new BadRequestException('Unsupported audio format'), false)
      },
    }),
  )
  async upload(
    @Param('stationId', new ParseUUIDPipe()) stationId: string,
    @Query('playlistId', new ParseUUIDPipe()) playlistId: string,
    @CurrentUser() user: { id: string },
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided')
    return this.tracksService.upload(stationId, playlistId, user.id, file)
  }

  @Get('stations/:stationId/tracks')
  @UseGuards(JwtAuthGuard)
  getStationTracks(
    @Param('stationId', new ParseUUIDPipe()) stationId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.tracksService.getStationTracks(stationId, user.id)
  }

  @Get('tracks/:id/stream')
  @UseGuards(OptionalJwtGuard)
  @SkipThrottle()
  async streamTrack(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('quality') quality: string | undefined,
    @CurrentUser() user: { id: string } | null,
    @Headers('range') rangeHeader: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ) {
    return this.tracksService.streamTrack(id, res, rangeHeader, user?.id, ifNoneMatch, quality)
  }

  @Get('tracks/:id/manifest')
  @UseGuards(OptionalJwtGuard)
  @SkipThrottle()
  async getStreamManifest(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('quality') quality: string | undefined,
    @CurrentUser() user: { id: string } | null,
  ) {
    return this.tracksService.getTrackStreamManifest(id, user?.id, quality)
  }

  @Get('tracks/:id/cover')
  @UseGuards(OptionalJwtGuard)
  @SkipThrottle()
  async getCover(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: { id: string } | null,
    @Res() res: Response,
  ) {
    return this.tracksService.getCover(id, res, user?.id)
  }

  @Get('tracks/:id/waveform')
  @UseGuards(OptionalJwtGuard)
  @SkipThrottle()
  getWaveform(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: { id: string } | null,
  ) {
    return this.tracksService.getWaveform(id, user?.id)
  }

  @Put('tracks/:id')
  @UseGuards(JwtAuthGuard)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: { id: string },
    @Body('title') title: string | null,
  ) {
    return this.tracksService.updateTrack(id, user.id, { title })
  }

  @Delete('tracks/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: { id: string }) {
    return this.tracksService.deleteTrack(id, user.id)
  }
}
