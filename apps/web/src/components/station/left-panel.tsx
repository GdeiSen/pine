'use client'

import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import { ChatMessageType, type ChatMessage } from '@web-radio/shared'

interface LeftPanelProps {
  isPlaying: boolean
  isPaused: boolean
  stationCode?: string
  stationName?: string
  stationDescription?: string | null
  stationPlaybackSeconds?: number | null
  messages: ChatMessage[]
  onSendMessage: (content: string) => void
  currentUserId?: string
  showMessages?: boolean
  showInput?: boolean
}

function formatPlaybackTime(secondsValue: number | null | undefined) {
  const safeSeconds = Number.isFinite(secondsValue) ? Math.max(0, Math.floor(secondsValue ?? 0)) : 0
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const seconds = safeSeconds % 60
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds
    .toString()
    .padStart(2, '0')}`
}

export function LeftPanel({
  isPlaying,
  isPaused,
  stationCode = '000000',
  stationName,
  stationDescription,
  stationPlaybackSeconds = 0,
  messages,
  onSendMessage,
  currentUserId,
  showMessages = true,
  showInput = true,
}: LeftPanelProps) {
  const isActive = isPlaying && !isPaused
  const top = stationCode.slice(0, 3)
  const bottom = stationCode.slice(3, 6)
  const [input, setInput] = useState('')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 300)
    return () => window.clearInterval(timer)
  }, [])

  const visibleMessages = useMemo(() => {
    return messages
      .filter((message) => {
        const parsed = Date.parse(message.createdAt)
        const createdAtMs = Number.isNaN(parsed) ? now : parsed
        return now - createdAtMs <= 5000
      })
      .slice(-4)
  }, [messages, now])

  const currentTimeLabel = useMemo(
    () =>
      new Date(now).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    [now],
  )
  const playbackTimeLabel = useMemo(
    () => formatPlaybackTime(stationPlaybackSeconds),
    [stationPlaybackSeconds],
  )

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = input.trim()
    if (!value) return
    onSendMessage(value)
    setInput('')
  }

  return (
    <div
      className="relative w-full h-full flex flex-col overflow-hidden"
      style={{ background: 'var(--bg-panel)' }}
    >
      {/* Numbers — flush to top */}
      <div className="flex flex-col pt-10 w-full px-4">
        {/* Top row */}
        <div className="w-full flex justify-center">
          <motion.p
            className="font-black tabular-nums leading-none text-center w-full"
            style={{
              fontSize: 'clamp(80px, 15vw, 116px)',
              letterSpacing: '0.04em',
              color: '#ffffff',
            }}
            animate={{ opacity: isActive ? 1 : 0.6 }}
            transition={{ duration: 0.8 }}
          >
            {top}
          </motion.p>
        </div>
        <motion.p
          className="font-black tabular-nums leading-none text-center w-full"
          style={{
            fontSize: 'clamp(80px, 15vw, 116px)',
            letterSpacing: '0.04em',
            color: '#ffffff',
          }}
          animate={{ opacity: isActive ? 1 : 0.6 }}
          transition={{ duration: 0.8 }}
        >
          {bottom}
        </motion.p>
      </div>

      {/* Station name + description */}
      {stationName && (
        <div className="px-8 mt-6 space-y-2">
          <p
            className="font-bold uppercase tracking-[0.14em] whitespace-normal break-words"
            style={{ fontSize: 'clamp(14px, 1.8vw, 18px)', color: 'rgba(255,255,255,0.55)' }}
          >
            {stationName}
          </p>
          {stationDescription && (
            <p
              className="text-xs leading-relaxed whitespace-pre-wrap break-words"
              style={{ color: 'rgba(255,255,255,0.22)' }}
            >
              {stationDescription}
            </p>
          )}
          <p
            className="text-[11px] tracking-[0.08em] uppercase whitespace-nowrap overflow-hidden text-ellipsis"
            style={{ color: 'rgba(255,255,255,0.36)' }}
          >
            {currentTimeLabel} • {playbackTimeLabel}
          </p>
        </div>
      )}

      {showMessages && (
        <div className="px-8 mt-4 min-h-[112px] space-y-2">
          <AnimatePresence initial={false}>
            {visibleMessages.map((message) => {
              const isSystem = message.type !== ChatMessageType.TEXT
              const author = message.user?.username ?? 'System'

              return (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18 }}
                  className="text-xs leading-snug text-white/88"
                >
                  {isSystem ? (
                    <p className="break-words">{message.content}</p>
                  ) : (
                    <p className="break-words">
                      <span className="text-white/55">{author}: </span>
                      <span className="text-white">{message.content}</span>
                    </p>
                  )}
                </motion.div>
              )
            })}
          </AnimatePresence>
        </div>
      )}

      {/* Playing indicator */}
      <div className="mt-auto px-8 pb-5">
        <div className="flex items-end gap-[3px]">
          {[0.6, 1.0, 0.75, 0.9, 0.5].map((maxH, i) => (
            <motion.div
              key={i}
              className="rounded-full flex-shrink-0"
              style={{ width: 3, background: 'rgba(255,255,255,0.28)' }}
              animate={
                isActive
                  ? { height: [3, 18 * maxH, 3 * maxH, 18 * maxH, 3] }
                  : { height: 3 }
              }
              transition={{
                duration: 1.2 + i * 0.1,
                repeat: isActive ? Infinity : 0,
                delay: i * 0.1,
                ease: 'easeInOut',
              }}
            />
          ))}
        </div>
      </div>

      {showInput && (
        <form
          onSubmit={handleSubmit}
          className="h-16 px-4 border-t border-white/10 bg-black/20 flex items-center"
        >
          <div className="flex items-center gap-2 w-full">
            <input
              data-no-focus-ring="true"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Message..."
              maxLength={500}
              className="h-9 flex-1 px-0 text-sm bg-transparent text-white placeholder:text-white/45 border-none outline-none ring-0 appearance-none focus:outline-none focus:ring-0 focus:border-none focus-visible:outline-none focus-visible:ring-0 focus-visible:border-none"
              style={{ boxShadow: 'none' }}
            />
            <button
              type="submit"
              disabled={!input.trim()}
              className="h-9 w-9 flex items-center justify-center rounded-xl text-white disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Send message"
            >
              <ArrowUpRight size={16} />
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
