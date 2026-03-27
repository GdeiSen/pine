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
  Req,
  Res,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { diskStorage } from 'multer'
import * as path from 'path'
import * as fs from 'fs'
import { v4 as uuid } from 'uuid'
import { Request, Response } from 'express'
import { ConfigService } from '@nestjs/config'
import { TracksService } from './tracks.service'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'
import { CurrentUser } from '../../common/decorators/current-user.decorator'
import { SUPPORTED_AUDIO_FORMATS, MAX_FILE_SIZE_BYTES } from '@web-radio/shared'

@Controller()
export class TracksController {
  constructor(
    private tracksService: TracksService,
    private configService: ConfigService,
  ) {}

  @Post('stations/:stationId/tracks/upload')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (req: any, _file, cb) => {
          const storagePath = process.env.STORAGE_PATH ?? './storage'
          const dir = path.join(storagePath, 'stations', req.params.stationId, 'tracks')
          fs.mkdirSync(dir, { recursive: true })
          cb(null, dir)
        },
        filename: (_req, file, cb) => {
          const ext = path.extname(file.originalname)
          cb(null, `${uuid()}${ext}`)
        },
      }),
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (SUPPORTED_AUDIO_FORMATS.includes(file.mimetype)) cb(null, true)
        else cb(new BadRequestException('Unsupported audio format'), false)
      },
    }),
  )
  async upload(
    @Param('stationId') stationId: string,
    @Query('playlistId') playlistId: string,
    @CurrentUser() user: { id: string },
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided')
    if (!playlistId) throw new BadRequestException('playlistId is required')
    return this.tracksService.upload(stationId, playlistId, user.id, file)
  }

  @Get('stations/:stationId/tracks')
  @UseGuards(JwtAuthGuard)
  getStationTracks(@Param('stationId') stationId: string) {
    return this.tracksService.getStationTracks(stationId)
  }

  @Get('tracks/:id/stream')
  async stream(
    @Param('id') id: string,
    @Query('quality') quality: string | undefined,
    @Headers('range') range: string,
    @Res() res: Response,
  ) {
    return this.tracksService.streamTrack(id, range, res, quality)
  }

  @Get('tracks/:id/cover')
  async getCover(@Param('id') id: string, @Res() res: Response) {
    return this.tracksService.getCover(id, res)
  }

  @Get('tracks/:id/waveform')
  getWaveform(@Param('id') id: string) {
    return this.tracksService.getWaveform(id)
  }

  @Put('tracks/:id')
  @UseGuards(JwtAuthGuard)
  update(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
    @Body('title') title: string | null,
  ) {
    return this.tracksService.updateTrack(id, user.id, { title })
  }

  @Delete('tracks/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.tracksService.deleteTrack(id, user.id)
  }
}
