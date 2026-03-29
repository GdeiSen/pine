import {
  Controller,
  Post,
  Body,
  Get,
  Put,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import { Request, Response } from 'express'
import { AuthService } from './auth.service'
import { RegisterDto } from './dto/register.dto'
import { LoginDto } from './dto/login.dto'
import { UpdateMeDto } from './dto/update-me.dto'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'
import { CurrentUser } from '../../common/decorators/current-user.decorator'

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.register(dto)
    this.setRefreshCookie(res, result.refreshToken)
    this.setAccessCookie(res, result.accessToken)
    return { accessToken: result.accessToken, user: result.user }
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(dto)
    this.setRefreshCookie(res, result.refreshToken)
    this.setAccessCookie(res, result.accessToken)
    return { accessToken: result.accessToken, user: result.user }
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.['refresh_token']
    const result = await this.authService.refresh(refreshToken)
    this.setRefreshCookie(res, result.refreshToken)
    this.setAccessCookie(res, result.accessToken)
    return { accessToken: result.accessToken, user: result.user }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.['refresh_token']
    if (refreshToken) await this.authService.logout(refreshToken)
    res.clearCookie('refresh_token', {
      path: '/api/auth',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    })
    res.clearCookie('access_token', {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    })
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@CurrentUser() user: { id: string }) {
    return this.authService.getMe(user.id)
  }

  @Put('me')
  @UseGuards(JwtAuthGuard)
  async updateMe(@CurrentUser() user: { id: string }, @Body() dto: UpdateMeDto) {
    return this.authService.updateMe(user.id, dto)
  }

  private setRefreshCookie(res: Response, token: string) {
    res.cookie('refresh_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/auth',
    })
  }

  private setAccessCookie(res: Response, token: string) {
    res.cookie('access_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 15 * 60 * 1000,
      path: '/',
    })
  }
}
