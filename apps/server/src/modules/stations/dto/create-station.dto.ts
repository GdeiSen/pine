import { Transform } from 'class-transformer'
import { IsString, MinLength, MaxLength, IsOptional, IsEnum, IsBoolean } from 'class-validator'
import { StationAccessMode } from '@web-radio/shared'

export class CreateStationDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
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
