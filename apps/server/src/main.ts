import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { AppModule } from './app.module'
import { isAllowedOrigin, resolveAllowedOrigins } from './common/security/cors'
import { RedisIoAdapter } from './common/realtime/redis-io.adapter'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  })

  const configService = app.get(ConfigService)
  const clientUrl = configService.get<string>('CLIENT_URL', 'http://localhost:3000')
  const port = configService.get<number>('PORT', 3001)
  const redisUrl = configService.get<string>('REDIS_URL')?.trim()
  const jwtSecret = configService.get<string>('JWT_SECRET')?.trim()
  const weakSecret =
    !jwtSecret || jwtSecret.length < 32 || /super-secret|change-in-production/i.test(jwtSecret)

  if (weakSecret && process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is missing or too weak for production')
  }
  if (weakSecret) {
    console.warn('[security] JWT_SECRET is weak. Use a long random value before production deploy.')
  }

  const allowedOrigins = resolveAllowedOrigins(
    configService.get<string>('ALLOWED_ORIGINS'),
    clientUrl,
  )

  if (redisUrl) {
    const redisAdapter = new RedisIoAdapter(app)
    await redisAdapter.connectToRedis(redisUrl)
    app.useWebSocketAdapter(redisAdapter)
    app.enableShutdownHooks()
  } else {
    console.warn('[realtime] REDIS_URL is not set. Running with single-instance Socket.IO fanout.')
  }

  app.use(cookieParser())
  const httpServer = app.getHttpAdapter().getInstance()
  if (httpServer && typeof httpServer.set === 'function') {
    httpServer.set('trust proxy', 1)
  }
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  )

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (isAllowedOrigin(origin, allowedOrigins)) {
        callback(null, true)
        return
      }
      callback(new Error('Origin is not allowed by CORS'))
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })

  app.setGlobalPrefix('api')

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  )

  await app.listen(port)
  console.log(`🚀 Server running on http://localhost:${port}/api`)
}

bootstrap()
