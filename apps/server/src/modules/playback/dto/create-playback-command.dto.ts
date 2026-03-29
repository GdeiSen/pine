import { PlaybackCommandType } from '@web-radio/shared'
import { Allow, IsEnum, IsOptional } from 'class-validator'

export class CreatePlaybackCommandDto {
  @IsEnum(PlaybackCommandType)
  type: PlaybackCommandType

  @IsOptional()
  @Allow()
  payload?: unknown
}
