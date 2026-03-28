import type { Metadata } from 'next'
import { ThemeProvider } from 'next-themes'
import { QueryProvider } from '@/components/providers/query-provider'
import '@/styles/globals.css'

export const metadata: Metadata = {
  title: {
    default: 'PINE',
    template: '%s · PINE',
  },
  description: 'PINE — создавайте свои радиостанции и слушайте музыку вместе',
  manifest: '/manifest.json',
  themeColor: '#6366f1',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          <QueryProvider>{children}</QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
