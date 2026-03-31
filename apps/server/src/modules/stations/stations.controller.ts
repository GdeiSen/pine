import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  ParseIntPipe,
  BadRequestException,
  UseInterceptors,
  UploadedFile,
  Headers,
  Res,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { SkipThrottle } from '@nestjs/throttler'
import { diskStorage } from 'multer'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { v4 as uuid } from 'uuid'
import { Response } from 'express'
import { StationsService } from './stations.service'
import { CreateStationDto } from './dto/create-station.dto'
import { UpdateStationDto } from './dto/update-station.dto'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'
import { OptionalJwtGuard } from '../../common/guards/optional-jwt.guard'
import { CurrentUser } from '../../common/decorators/current-user.decorator'
import { IsOptional, IsString } from 'class-validator'

class JoinDto {
  @IsOptional()
  @IsString()
  password?: string
}

@Controller('stations')
export class StationsController {
  constructor(private stationsService: StationsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@CurrentUser() user: { id: string }, @Body() dto: CreateStationDto) {
    return this.stationsService.create(user.id, dto)
  }

  @Get('my')
  @UseGuards(JwtAuthGuard)
  getMyStations(@CurrentUser() user: { id: string }) {
    return this.stationsService.getMyStations(user.id)
  }

  @Get('discover')
  getPublicStations() {
    return this.stationsService.getPublicStations()
  }

  @Post(':id/preview-videos/upload')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req: any, _file, cb) => {
          const dir = path.join(os.tmpdir(), 'pine-preview-videos')
          fs.mkdirSync(dir, { recursive: true })
          cb(null, dir)
        },
        filename: (_req, file, cb) => {
          const ext = path.extname(file.originalname).toLowerCase() || '.mp4'
          cb(null, `${uuid()}${ext}`)
        },
      }),
      limits: { fileSize: 120 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (String(file.mimetype || '').toLowerCase().startsWith('video/')) {
          cb(null, true)
          return
        }
        cb(new BadRequestException('Unsupported video format'), false)
      },
    }),
  )
  uploadPreviewVideo(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: { id: string },
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided')
    return this.stationsService.uploadPreviewVideo(id, user.id, file)
  }

  @Post(':id/cover/upload')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req: any, _file, cb) => {
          const dir = path.join(os.tmpdir(), 'pine-station-covers')
          fs.mkdirSync(dir, { recursive: true })
          cb(null, dir)
        },
        filename: (_req, file, cb) => {
          const ext = path.extname(file.originalname).toLowerCase() || '.jpg'
          cb(null, `${uuid()}${ext}`)
        },
      }),
      limits: { fileSize: 15 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (String(file.mimetype || '').toLowerCase().startsWith('image/')) {
          cb(null, true)
          return
        }
        cb(new BadRequestException('Unsupported image format'), false)
      },
    }),
  )
  uploadStationCover(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: { id: string },
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided')
    return this.stationsService.uploadStationCover(id, user.id, file)
  }

  @Delete(':id/cover')
  @UseGuards(JwtAuthGuard)
  deleteStationCover(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.stationsService.deleteStationCover(id, user.id)
  }

  @Delete(':id/preview-videos/:index')
  @UseGuards(JwtAuthGuard)
  deletePreviewVideo(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('index', ParseIntPipe) index: number,
    @CurrentUser() user: { id: string },
  ) {
    return this.stationsService.deletePreviewVideo(id, index, user.id)
  }

  @Get(':id/preview-videos/:index/stream')
  @UseGuards(OptionalJwtGuard)
  @SkipThrottle()
  streamPreviewVideo(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('index', ParseIntPipe) index: number,
    @CurrentUser() user: { id: string } | null,
    @Headers('range') rangeHeader: string | undefined,
    @Res() res: Response,
  ) {
    return this.stationsService.streamPreviewVideo(id, index, res, rangeHeader, user?.id)
  }

  @Get(':id/cover/stream')
  @UseGuards(OptionalJwtGuard)
  @SkipThrottle()
  streamStationCover(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: { id: string } | null,
    @Res() res: Response,
  ) {
    return this.stationsService.streamStationCover(id, res, user?.id)
  }

  @Get(':code/stream-info')
  @UseGuards(OptionalJwtGuard)
  getStreamInfo(
    @Param('code') code: string,
    @CurrentUser() user: { id: string } | null,
  ) {
    if (!/^\d{6}$/.test(code)) {
      throw new BadRequestException('Invalid station code')
    }
    return this.stationsService.getStreamInfo(code, user?.id)
  }

  @Get(':code')
  @UseGuards(OptionalJwtGuard)
  findByCode(@Param('code') code: string, @CurrentUser() user: { id: string } | null) {
    if (!/^\d{6}$/.test(code)) {
      throw new BadRequestException('Invalid station code')
    }
    return this.stationsService.findByCode(code, user?.id)
  }

  @Post(':code/join')
  @UseGuards(JwtAuthGuard)
  join(
    @Param('code') code: string,
    @CurrentUser() user: { id: string },
    @Body() dto: JoinDto,
  ) {
    if (!/^\d{6}$/.test(code)) {
      throw new BadRequestException('Invalid station code')
    }
    return this.stationsService.join(code, user.id, dto.password)
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: { id: string },
    @Body() dto: UpdateStationDto,
  ) {
    return this.stationsService.update(id, user.id, dto)
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: { id: string }) {
    return this.stationsService.delete(id, user.id)
  }
}
