import type { NextConfig } from 'next'

const backendProxyTarget = process.env.BACKEND_PROXY_TARGET ?? 'http://localhost:3001'

const nextConfig: NextConfig = {
  transpilePackages: ['@web-radio/shared'],
  experimental: {
    proxyClientMaxBodySize: 200 * 1024 * 1024,
  } as any,
  images: {
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost', port: '3001' },
    ],
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${backendProxyTarget}/api/:path*`,
      },
    ]
  },
}

export default nextConfig
