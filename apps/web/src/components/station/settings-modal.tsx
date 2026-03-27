'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import api from '@/lib/api'

interface StationSettingsModalProps {
  stationId: string
  initialName: string
  initialDescription: string | null
  onClose: () => void
  onSaved: (name: string, description: string | null) => void
}

export function StationSettingsModal({
  stationId,
  initialName,
  initialDescription,
  onClose,
  onSaved,
}: StationSettingsModalProps) {
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription ?? '')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  async function handleSave() {
    if (!name.trim()) return
    setError('')
    setIsLoading(true)
    try {
      await api.put(`/stations/${stationId}`, {
        name: name.trim(),
        description: description.trim() || null,
      })
      onSaved(name.trim(), description.trim() || null)
      onClose()
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Failed to save')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0"
        style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
        onClick={onClose}
      />

      {/* Panel */}
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.18 }}
        className="relative z-10 w-full max-w-md rounded-2xl overflow-hidden"
        style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-lg)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <h2 className="font-semibold text-[--text-primary]">Station Settings</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>

        {/* Form */}
        <div className="px-5 py-5 space-y-4">
          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[--text-muted] uppercase tracking-wider">
              Station Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              placeholder="My Radio Station"
              maxLength={60}
              className="w-full h-10 px-3 rounded-xl text-sm text-[--text-primary] placeholder:text-[--text-muted] focus:outline-none transition-colors"
              style={{
                background: 'var(--bg-subtle)',
                border: '1.5px solid transparent',
              }}
              onFocus={(e) => e.currentTarget.style.borderColor = 'var(--color-accent)'}
              onBlur={(e) => e.currentTarget.style.borderColor = 'transparent'}
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[--text-muted] uppercase tracking-wider">
              Description
              <span className="ml-2 normal-case tracking-normal font-normal text-[--text-muted]">optional</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A short description of your station…"
              maxLength={300}
              rows={3}
              className="w-full px-3 py-2.5 rounded-xl text-sm text-[--text-primary] placeholder:text-[--text-muted] focus:outline-none transition-colors resize-none"
              style={{
                background: 'var(--bg-subtle)',
                border: '1.5px solid transparent',
              }}
              onFocus={(e) => e.currentTarget.style.borderColor = 'var(--color-accent)'}
              onBlur={(e) => e.currentTarget.style.borderColor = 'transparent'}
            />
            <p className="text-[11px] text-[--text-muted] text-right">{description.length}/300</p>
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-400/10 px-3 py-2 rounded-xl">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 pb-5">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!name.trim() || isLoading}
            isLoading={isLoading}
          >
            {!isLoading && <Check size={13} />}
            Save Changes
          </Button>
        </div>
      </motion.div>
    </div>
  )
}
