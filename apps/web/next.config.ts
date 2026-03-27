import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  transpilePackages: ['@web-radio/shared'],
  images: {
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost', port: '3001' },
    ],
  },
}

export default nextConfig
