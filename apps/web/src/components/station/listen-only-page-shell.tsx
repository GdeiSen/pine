'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Moon, Radio, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { LeftPanel } from '@/components/station/left-panel'
import { HeaderVolumeControl } from '@/components/station/header-volume-control'
import type { ChatMessage } from '@web-radio/shared'

interface ListenOnlyPageShellProps {
  stationCode: string
  stationName?: string
  stationDescription?: string | null
  stationCoverImage?: string | null
  stationPlaybackSeconds?: number | null
  isPlaying: boolean
  isPaused: boolean
  homeHref: string
  showConnectionDot?: boolean
  isConnected?: boolean
  messages?: ChatMessage[]
  onSendMessage?: (content: string) => void
  currentUserId?: string
  showChatMessages?: boolean
  showChatInput?: boolean
  children: React.ReactNode
}

export function ListenOnlyPageShell({
  stationCode,
  stationName,
  stationDescription,
  stationCoverImage,
  stationPlaybackSeconds = 0,
  isPlaying,
  isPaused,
  homeHref,
  showConnectionDot = false,
  isConnected = false,
  messages = [],
  onSendMessage = () => {},
  currentUserId,
  showChatMessages = true,
  showChatInput = true,
  children,
}: ListenOnlyPageShellProps) {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg-elevated)' }}>
      <header
        className="sticky top-0 z-50 relative flex items-center justify-between px-5 h-13 lg:ml-[340px]"
        style={{
          background: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <div className="flex items-center gap-3">
          <Link href={homeHref} className="flex items-center gap-3" title="Go to stations list">
            <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'var(--color-accent)' }}>
              <Radio size={12} style={{ color: 'var(--bg)' }} />
            </div>
            <span className="font-semibold text-[--text-primary] text-sm tracking-[0.08em]">PINE</span>
          </Link>
          {showConnectionDot && (
            <div
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{
                background: isConnected ? '#22c55e' : 'var(--text-muted)',
                boxShadow: isConnected ? '0 0 5px #22c55e70' : 'none',
              }}
            />
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <HeaderVolumeControl />
          <Button variant="ghost" size="icon-sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {mounted && (theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />)}
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden lg:ml-[340px]" style={{ background: 'var(--bg-elevated)' }}>
        <aside
          className="hidden lg:flex fixed left-0 top-0 h-screen w-[340px] flex-col min-h-0 z-40"
          style={{ borderRight: '1px solid var(--border)' }}
        >
          <div className="flex-1 min-h-0">
            <LeftPanel
              isPlaying={isPlaying}
              isPaused={isPaused}
              stationCode={stationCode}
              stationName={stationName}
              stationDescription={stationDescription}
              stationCoverImage={stationCoverImage}
              stationPlaybackSeconds={stationPlaybackSeconds}
              messages={messages}
              onSendMessage={onSendMessage}
              currentUserId={currentUserId}
              showMessages={showChatMessages}
              showInput={showChatInput}
            />
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto" style={{ background: 'var(--bg-elevated)' }}>
          <section className="w-full p-0">
            {children}
          </section>
        </main>
      </div>
    </div>
  )
}
