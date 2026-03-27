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
import { QueueService } from './queue.service'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'
import { CurrentUser } from '../../common/decorators/current-user.decorator'
import { IsArray, IsNumber, ValidateNested, IsOptional, IsIn, IsUUID } from 'class-validator'
import { Type } from 'class-transformer'

class AddToQueueDto {
  @IsUUID()
  trackId: string

  @IsOptional()
  @IsIn(['end', 'next', 'now'])
  mode?: 'end' | 'next' | 'now'

  @IsOptional()
  @IsUUID()
  beforeItemId?: string
}

class ReorderItemDto {
  @IsUUID()
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
  getQueue(
    @Param('stationId', new ParseUUIDPipe()) stationId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.queueService.getQueue(stationId, user.id)
  }

  @Post()
  addToQueue(
    @Param('stationId', new ParseUUIDPipe()) stationId: string,
    @Body() dto: AddToQueueDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.queueService.addToQueue(stationId, dto.trackId, user.id, {
      mode: dto.mode,
      beforeItemId: dto.beforeItemId,
    })
  }

  @Put('reorder')
  reorder(
    @Param('stationId', new ParseUUIDPipe()) stationId: string,
    @Body() dto: ReorderQueueDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.queueService.reorderQueue(stationId, dto.items, user.id)
  }

  @Delete(':itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('stationId', new ParseUUIDPipe()) stationId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.queueService.removeFromQueue(stationId, itemId, user.id)
  }
}
