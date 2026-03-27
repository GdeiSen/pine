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
} from '@nestjs/common'
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

  @Get(':code')
  @UseGuards(OptionalJwtGuard)
  findByCode(@Param('code') code: string, @CurrentUser() user: { id: string } | null) {
    return this.stationsService.findByCode(code, user?.id)
  }

  @Post(':code/join')
  @UseGuards(JwtAuthGuard)
  join(
    @Param('code') code: string,
    @CurrentUser() user: { id: string },
    @Body() dto: JoinDto,
  ) {
    return this.stationsService.join(code, user.id, dto.password)
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  update(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
    @Body() dto: UpdateStationDto,
  ) {
    return this.stationsService.update(id, user.id, dto)
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.stationsService.delete(id, user.id)
  }
}
