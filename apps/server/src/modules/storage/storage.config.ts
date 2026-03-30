import { Client } from 'minio'

export type StorageScope = 'tracks' | 'covers' | 'transcodes'

export type StorageBuckets = {
  tracks: string
  covers: string
  transcodes: string
}

type MinioConnection = {
  endPoint: string
  port: number
  useSSL: boolean
  accessKey: string
  secretKey: string
}

export function resolveStorageBucketsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): StorageBuckets {
  return {
    tracks: env.MINIO_BUCKET_TRACKS ?? 'tracks',
    covers: env.MINIO_BUCKET_COVERS ?? 'covers',
    transcodes: env.MINIO_BUCKET_TRANSCODES ?? 'transcodes',
  }
}

export function resolveBucketByScope(scope: StorageScope, buckets: StorageBuckets): string {
  if (scope === 'tracks') return buckets.tracks
  if (scope === 'covers') return buckets.covers
  return buckets.transcodes
}

export function createMinioClientFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const config = resolveMinioConnection(env)
  return new Client(config)
}

function resolveMinioConnection(env: NodeJS.ProcessEnv): MinioConnection {
  const endpointRaw = (env.MINIO_ENDPOINT ?? '127.0.0.1:9000').trim()
  const accessKey = (env.MINIO_ACCESS_KEY ?? env.MINIO_ROOT_USER ?? '').trim()
  const secretKey = (env.MINIO_SECRET_KEY ?? env.MINIO_ROOT_PASSWORD ?? '').trim()

  if (!accessKey || !secretKey) {
    throw new Error('MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required')
  }

  if (/^https?:\/\//i.test(endpointRaw)) {
    const parsed = new URL(endpointRaw)
    return {
      endPoint: parsed.hostname,
      port: Number.parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10),
      useSSL: parsed.protocol === 'https:',
      accessKey,
      secretKey,
    }
  }

  const [host, rawPort] = endpointRaw.split(':')
  return {
    endPoint: host,
    port: Number.parseInt(rawPort || '9000', 10),
    useSSL: false,
    accessKey,
    secretKey,
  }
}
