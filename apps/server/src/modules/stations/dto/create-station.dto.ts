import { IsString, MinLength, MaxLength, IsOptional, IsEnum, IsBoolean } from 'class-validator'
import { StationAccessMode } from '@web-radio/shared'

export class CreateStationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name: string

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string

  @IsOptional()
  @IsEnum(StationAccessMode)
  accessMode?: StationAccessMode = StationAccessMode.PRIVATE

  @IsOptional()
  @IsBoolean()
  passwordEnabled?: boolean

  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(50)
  password?: string
}
