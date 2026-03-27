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
import { QueueService } from './queue.service'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'
import { CurrentUser } from '../../common/decorators/current-user.decorator'
import { IsString, IsArray, IsNumber, ValidateNested, IsOptional, IsIn } from 'class-validator'
import { Type } from 'class-transformer'

class AddToQueueDto {
  @IsString()
  trackId: string

  @IsOptional()
  @IsIn(['end', 'next', 'now'])
  mode?: 'end' | 'next' | 'now'

  @IsOptional()
  @IsString()
  beforeItemId?: string
}

class ReorderItemDto {
  @IsString()
  id: string

  @IsNumber()
  position: number
}

class ReorderQueueDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  items: ReorderItemDto[]
}

@Controller('stations/:stationId/queue')
@UseGuards(JwtAuthGuard)
export class QueueController {
  constructor(private queueService: QueueService) {}

  @Get()
  getQueue(@Param('stationId') stationId: string) {
    return this.queueService.getQueue(stationId)
  }

  @Post()
  addToQueue(
    @Param('stationId') stationId: string,
    @Body() dto: AddToQueueDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.queueService.addToQueue(stationId, dto.trackId, user.id, {
      mode: dto.mode,
      beforeItemId: dto.beforeItemId,
    })
  }

  @Put('reorder')
  reorder(@Param('stationId') stationId: string, @Body() dto: ReorderQueueDto) {
    return this.queueService.reorderQueue(stationId, dto.items)
  }

  @Delete(':itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('stationId') stationId: string, @Param('itemId') itemId: string) {
    return this.queueService.removeFromQueue(stationId, itemId)
  }
}
