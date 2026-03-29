import type { NextConfig } from 'next'

const streamProxyTarget = process.env.NEXT_PUBLIC_STREAM_PROXY_TARGET ?? 'http://icecast:8000'

const nextConfig: NextConfig = {
  transpilePackages: ['@web-radio/shared'],
  images: {
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost', port: '3001' },
    ],
  },
  async rewrites() {
    return [
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
