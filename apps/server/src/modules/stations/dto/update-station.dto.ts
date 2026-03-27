import { IsString, MinLength, MaxLength, IsOptional, IsEnum, IsInt, Min, Max, IsBoolean } from 'class-validator'
import { StationAccessMode, StreamQuality } from '@web-radio/shared'

export class UpdateStationDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string

  @IsOptional()
  @IsEnum(StationAccessMode)
  accessMode?: StationAccessMode

  @IsOptional()
  @IsBoolean()
  passwordEnabled?: boolean

  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(50)
  password?: string

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  crossfadeDuration?: number

  @IsOptional()
  @IsEnum(StreamQuality)
  streamQuality?: StreamQuality
}
