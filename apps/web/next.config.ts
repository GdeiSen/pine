import type { NextConfig } from 'next'

const backendProxyTarget = process.env.BACKEND_PROXY_TARGET ?? 'http://localhost:3001'
const streamProxyTarget = process.env.NEXT_PUBLIC_STREAM_PROXY_TARGET ?? 'http://icecast:8000'

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
      {
        source: '/live.mp3',
        destination: `${streamProxyTarget}/live.mp3`,
      },
      {
        source: '/live/:path*',
        destination: `${streamProxyTarget}/live/:path*`,
      },
      {
        source: '/status-json.xsl',
        destination: `${streamProxyTarget}/status-json.xsl`,
      },
    ]
  },
}

export default nextConfig
