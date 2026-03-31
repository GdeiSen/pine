import { IsString, MinLength, MaxLength } from 'class-validator'

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword: string

  @IsString()
  @MinLength(6)
  @MaxLength(100)
  newPassword: string
}
