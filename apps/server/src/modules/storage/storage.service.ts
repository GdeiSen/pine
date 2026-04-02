import { Injectable } from '@nestjs/common'
import * as fs from 'fs'
import {
  StorageScope,
  createMinioClientFromEnv,
  resolveBucketByScope,
  resolveStorageBucketsFromEnv,
} from './storage.config'

export interface StorageUploadResult {
  bucket: string
  key: string
  size: number
}

@Injectable()
export class StorageService {
  private readonly client = createMinioClientFromEnv()
  private readonly buckets = resolveStorageBucketsFromEnv()
  private readonly minioPublicEndpoint = String(process.env.MINIO_PUBLIC_ENDPOINT ?? '').trim()

  buildObjectKey(parts: {
    stationId: string
    scope: StorageScope
    fileName: string
  }) {
    return ['stations', parts.stationId, parts.scope, parts.fileName].join('/')
  }

  async presignGetUrl(scope: StorageScope, key: string, expiresInSeconds = 900) {
    const bucket = resolveBucketByScope(scope, this.buckets)
    const presigned = await this.client.presignedGetObject(bucket, key, expiresInSeconds)
    return this.rewritePresignedUrlForPublicAccess(presigned)
  }

  buildPublicObjectUrl(scope: StorageScope, key: string) {
    if (!this.minioPublicEndpoint) return null
    try {
      const base = new URL(this.minioPublicEndpoint)
      const bucket = resolveBucketByScope(scope, this.buckets)
      const keyPath = key
        .split('/')
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join('/')
      const basePath = base.pathname.endsWith('/')
        ? base.pathname.slice(0, -1)
        : base.pathname
      const objectPath = `${basePath}/${bucket}/${keyPath}`.replace(/\/{2,}/g, '/')
      return `${base.protocol}//${base.host}${objectPath}`
    } catch {
      return null
    }
  }

  async uploadBuffer(
    scope: StorageScope,
    key: string,
    body: Buffer,
    contentType?: string,
  ): Promise<StorageUploadResult> {
    const bucket = resolveBucketByScope(scope, this.buckets)
    await this.client.putObject(bucket, key, body, body.byteLength, {
      'Content-Type': contentType ?? 'application/octet-stream',
    })

    return {
      bucket,
      key,
      size: body.byteLength,
    }
  }

  async uploadFile(
    scope: StorageScope,
    key: string,
    filePath: string,
    contentType?: string,
  ): Promise<StorageUploadResult> {
    const bucket = resolveBucketByScope(scope, this.buckets)
    const stat = fs.statSync(filePath)
    await this.client.fPutObject(bucket, key, filePath, {
      'Content-Type': contentType ?? 'application/octet-stream',
    })

    return {
      bucket,
      key,
      size: stat.size,
    }
  }

  async getObjectStream(scope: StorageScope, key: string) {
    const bucket = resolveBucketByScope(scope, this.buckets)
    return this.client.getObject(bucket, key)
  }

  async getPartialObjectStream(scope: StorageScope, key: string, offset: number, length: number) {
    const bucket = resolveBucketByScope(scope, this.buckets)
    return this.client.getPartialObject(bucket, key, offset, length)
  }

  async getObjectStat(scope: StorageScope, key: string) {
    const bucket = resolveBucketByScope(scope, this.buckets)
    return this.client.statObject(bucket, key)
  }

  async getObjectBuffer(scope: StorageScope, key: string) {
    const stream = await this.getObjectStream(scope, key)
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve())
    })
    return Buffer.concat(chunks)
  }

  async deleteObject(scope: StorageScope, key: string) {
    const bucket = resolveBucketByScope(scope, this.buckets)
    await this.client.removeObject(bucket, key)
    return {
      bucket,
      key,
    }
  }

  private rewritePresignedUrlForPublicAccess(url: string) {
    if (!this.minioPublicEndpoint) return url

    try {
      const publicBase = new URL(this.minioPublicEndpoint)
      const presigned = new URL(url)
      presigned.protocol = publicBase.protocol
      presigned.hostname = publicBase.hostname
      presigned.port = publicBase.port
      if (publicBase.pathname && publicBase.pathname !== '/') {
        const basePath = publicBase.pathname.endsWith('/')
          ? publicBase.pathname.slice(0, -1)
          : publicBase.pathname
        presigned.pathname = `${basePath}${presigned.pathname}`
      }
      return presigned.toString()
    } catch {
      return url
    }
  }
}
