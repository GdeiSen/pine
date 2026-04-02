import { INestApplicationContext, Logger } from '@nestjs/common'
import { IoAdapter } from '@nestjs/platform-socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { createClient } from 'redis'
import type { Server, ServerOptions } from 'socket.io'

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name)
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null
  private pubClient: ReturnType<typeof createClient> | null = null
  private subClient: ReturnType<typeof createClient> | null = null

  constructor(app: INestApplicationContext) {
    super(app)
  }

  async connectToRedis(redisUrl: string) {
    const pubClient = createClient({ url: redisUrl })
    const subClient = pubClient.duplicate()

    pubClient.on('error', (error) => {
      this.logger.error(`Redis pub client error: ${error instanceof Error ? error.message : String(error)}`)
    })
    subClient.on('error', (error) => {
      this.logger.error(`Redis sub client error: ${error instanceof Error ? error.message : String(error)}`)
    })

    await Promise.all([pubClient.connect(), subClient.connect()])
    this.adapterConstructor = createAdapter(pubClient, subClient)
    this.pubClient = pubClient
    this.subClient = subClient

    this.logger.log(`Socket.IO Redis fanout enabled (${this.maskRedisUrl(redisUrl)})`)
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor)
    }
    return server
  }

  async close() {
    const closeClient = async (client: ReturnType<typeof createClient> | null) => {
      if (!client) return
      if (!client.isOpen) return
      try {
        await client.quit()
      } catch {
        client.disconnect()
      }
    }

    await Promise.all([closeClient(this.pubClient), closeClient(this.subClient)])
    this.pubClient = null
    this.subClient = null
    this.adapterConstructor = null
  }

  private maskRedisUrl(redisUrl: string) {
    try {
      const parsed = new URL(redisUrl)
      if (parsed.password) {
        parsed.password = '***'
      }
      return parsed.toString()
    } catch {
      return redisUrl
    }
  }
}

