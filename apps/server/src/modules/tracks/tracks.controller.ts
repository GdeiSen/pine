import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Res,
  Headers,
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
        destination: (req: any, _file, cb) => {
          const stationId = String(req.params?.stationId ?? '')
          if (!/^[0-9a-f-]{36}$/i.test(stationId)) {
            cb(new BadRequestException('Invalid station ID') as any, '')
            return
          }

          const storagePath = path.resolve(process.env.STORAGE_PATH ?? './storage')
          const dir = path.join(storagePath, 'stations', stationId, 'tracks')
          const normalizedDir = path.resolve(dir)
          if (!normalizedDir.startsWith(`${storagePath}${path.sep}`)) {
            cb(new BadRequestException('Invalid upload path') as any, '')
            return
          }

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
        const isMimeAllowed = SUPPORTED_AUDIO_FORMATS.includes(file.mimetype)
        const isExtAllowed = SUPPORTED_EXTENSIONS.includes(ext)
        if (isMimeAllowed && isExtAllowed) cb(null, true)
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
  async stream(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('quality') quality: string | undefined,
    @Headers('range') range: string,
    @CurrentUser() user: { id: string } | null,
    @Res() res: Response,
  ) {
    return this.tracksService.streamTrack(id, range, res, quality, user?.id)
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
