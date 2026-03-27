'use client'

import { useState, useRef, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getAvatarFallback } from '@/lib/utils'
import type { ChatMessage } from '@web-radio/shared'

interface ChatPanelProps {
  messages: ChatMessage[]
  onSend: (content: string) => void
  currentUserId?: string
}

function formatSentAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function MessageBubble({ message, isOwn }: { message: ChatMessage; isOwn: boolean }) {
  const isSystem = message.type !== 'TEXT'
  const displayName = message.user?.username ?? 'Unknown'
  const createdAtText = formatSentAt(message.createdAt)

  if (isSystem) {
    return (
      <div className="flex justify-center py-1">
        <span className="text-xs text-[--text-muted] bg-[--bg-subtle] px-3 py-1 rounded-full">
          {message.content}
        </span>
      </div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex gap-2 ${isOwn ? 'flex-row-reverse' : ''}`}
    >
      <div className="w-6 h-6 rounded-full bg-[--bg-subtle] flex-shrink-0 flex items-center justify-center text-[10px] font-medium">
        {message.user?.avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={message.user.avatar}
            alt={displayName}
            className="w-full h-full object-cover rounded-full"
          />
        ) : (
          getAvatarFallback(displayName.slice(0, 2))
        )}
      </div>
      <div className={`max-w-[75%] ${isOwn ? 'items-end' : 'items-start'} flex flex-col gap-0.5`}>
        <div className={`flex items-center gap-1 px-1 ${isOwn ? 'flex-row-reverse' : ''}`}>
          <span className="text-[10px] text-[--text-secondary]">{displayName}</span>
          {createdAtText ? (
            <span className="text-[10px] text-[--text-muted]">{createdAtText}</span>
          ) : null}
        </div>
        <div
          className={`px-3 py-1.5 rounded-2xl text-sm ${
            isOwn
              ? 'bg-[--color-accent] text-white rounded-br-sm'
              : 'bg-[--bg-subtle] text-[--text-primary] rounded-bl-sm'
          }`}
        >
          {message.content}
        </div>
      </div>
    </motion.div>
  )
}

export function ChatPanel({ messages, onSend, currentUserId }: ChatPanelProps) {
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim()) return
    onSend(input.trim())
    setInput('')
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-2 p-3 min-h-0">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-[--text-muted]">No messages yet</p>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isOwn={msg.user?.id === currentUserId}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-[--border]">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message..."
            maxLength={500}
            className="flex-1 h-9 px-3 rounded-xl bg-[--bg-subtle] text-sm text-[--text-primary] placeholder:text-[--text-muted] border border-transparent outline-none focus:outline-none focus-visible:outline-none ring-0 focus:ring-0 focus-visible:ring-0 focus:border-transparent transition-colors"
            style={{ outline: 'none', boxShadow: 'none' }}
          />
          <Button type="submit" size="icon" disabled={!input.trim()}>
            <Send size={15} />
          </Button>
        </div>
      </form>
    </div>
  )
}
