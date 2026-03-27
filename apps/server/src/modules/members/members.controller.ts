import {
  Controller,
  Get,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import { MembersService } from './members.service'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'
import { CurrentUser } from '../../common/decorators/current-user.decorator'
import { MemberRole } from '@web-radio/shared'
import { IsEnum, IsArray, IsString } from 'class-validator'

class UpdateRoleDto {
  @IsEnum(MemberRole)
  role: MemberRole
}

class UpdatePermissionsDto {
  @IsArray()
  @IsString({ each: true })
  permissions: string[]
}

@Controller('stations/:stationId/members')
@UseGuards(JwtAuthGuard)
export class MembersController {
  constructor(private membersService: MembersService) {}

  @Get()
  getMembers(@Param('stationId') stationId: string) {
    return this.membersService.getMembers(stationId)
  }

  @Put(':userId/role')
  updateRole(
    @Param('stationId') stationId: string,
    @Param('userId') userId: string,
    @CurrentUser() requester: { id: string },
    @Body() dto: UpdateRoleDto,
  ) {
    return this.membersService.updateRole(stationId, userId, requester.id, dto.role)
  }

  @Put(':userId/permissions')
  updatePermissions(
    @Param('stationId') stationId: string,
    @Param('userId') userId: string,
    @CurrentUser() requester: { id: string },
    @Body() dto: UpdatePermissionsDto,
  ) {
    return this.membersService.updatePermissions(stationId, userId, requester.id, dto.permissions)
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  kick(
    @Param('stationId') stationId: string,
    @Param('userId') userId: string,
    @CurrentUser() requester: { id: string },
  ) {
    return this.membersService.kick(stationId, userId, requester.id)
  }
}
