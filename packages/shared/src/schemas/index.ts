import { z } from 'zod'
import { StationAccessMode, SystemQueueMode } from '../types'

export const RegisterSchema = z.object({
  email: z.string().email('Invalid email'),
  username: z
    .string()
    .min(3, 'Min 3 characters')
    .max(30, 'Max 30 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Only letters, numbers, _ and -'),
  password: z.string().min(6, 'Min 6 characters').max(100),
})

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export const CreateStationSchema = z.object({
  name: z.string().min(2, 'Min 2 characters').max(60),
  description: z.string().max(300).optional(),
  accessMode: z.nativeEnum(StationAccessMode).default(StationAccessMode.PRIVATE),
  passwordEnabled: z.boolean().optional(),
  password: z.string().min(4).max(50).optional(),
})

export const UpdateStationSchema = CreateStationSchema.partial()

export const CreatePlaylistSchema = z.object({
  name: z.string().min(1).max(80),
})

export const JoinStationSchema = z.object({
  password: z.string().optional(),
})

export const UpdateMemberSchema = z.object({
  role: z.string().optional(),
  permissions: z.array(z.string()).optional(),
})

export const CreateInviteSchema = z.object({
  maxUses: z.number().int().positive().optional(),
  expiresIn: z.number().int().positive().optional(), // hours
})

export type RegisterDto = z.infer<typeof RegisterSchema>
export type LoginDto = z.infer<typeof LoginSchema>
export type CreateStationDto = z.infer<typeof CreateStationSchema>
export type UpdateStationDto = z.infer<typeof UpdateStationSchema>
export type CreatePlaylistDto = z.infer<typeof CreatePlaylistSchema>
export type JoinStationDto = z.infer<typeof JoinStationSchema>
export type UpdateMemberDto = z.infer<typeof UpdateMemberSchema>
export type CreateInviteDto = z.infer<typeof CreateInviteSchema>
