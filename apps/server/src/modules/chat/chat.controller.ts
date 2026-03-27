import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import { ChatService } from './chat.service'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'

@Controller('stations/:stationId/chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private chatService: ChatService) {}

  @Get()
  getMessages(@Param('stationId') stationId: string, @Query('cursor') cursor?: string) {
    return this.chatService.getMessages(stationId, cursor)
  }
}
