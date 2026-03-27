'use client'

import { use, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { ArrowLeft, Lock, Radio, ShieldCheck, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import api from '@/lib/api'

type AccessMode = 'PUBLIC' | 'PRIVATE'

interface StationSettingsDto {
  id: string
  code: string
  name: string
  description: string | null
  accessMode: AccessMode
  isPasswordProtected: boolean
  crossfadeDuration: number
}

const ACCESS_OPTIONS: Array<{ value: AccessMode; label: string; hint: string }> = [
  { value: 'PRIVATE', label: 'Private', hint: 'Hidden from map, direct code only' },
  { value: 'PUBLIC', label: 'Public', hint: 'Visible in discovery' },
]

export default function StationSettingsPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params)
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const [station, setStation] = useState<StationSettingsDto | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [accessMode, setAccessMode] = useState<AccessMode>('PRIVATE')
  const [passwordEnabled, setPasswordEnabled] = useState(false)
  const [password, setPassword] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    api.get(`/stations/${code}`)
      .then((res) => {
        if (cancelled) return
        const data = res.data as StationSettingsDto
        setStation(data)
        setName(data.name ?? '')
        setDescription(data.description ?? '')
        setAccessMode(data.accessMode ?? 'PRIVATE')
        setPasswordEnabled(!!data.isPasswordProtected)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.response?.data?.message ?? 'Failed to load settings')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [code])

  const hasPasswordAlready = !!station?.isPasswordProtected

  const canSave = useMemo(() => {
    if (!station) return false
    if (!name.trim()) return false
    if (passwordEnabled && !hasPasswordAlready && password.trim().length < 4) return false
    return true
  }, [station, name, passwordEnabled, hasPasswordAlready, password])

  const handleSave = async () => {
    if (!station || !canSave) return
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      await api.put(`/stations/${station.id}`, {
        name: name.trim(),
        description: description.trim() || null,
        accessMode,
        passwordEnabled,
        crossfadeDuration: 3,
        ...(passwordEnabled && password.trim() ? { password: password.trim() } : {}),
      })
      setSaved(true)
      setStation({
        ...station,
        name: name.trim(),
        description: description.trim() || null,
        accessMode,
        crossfadeDuration: 3,
        isPasswordProtected: passwordEnabled ? (password.trim().length >= 4 || hasPasswordAlready) : false,
      })
      setPassword('')
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteStation = async () => {
    if (!station || deleting) return
    const confirmed = window.confirm(
      `Delete station "${station.name}" permanently? This cannot be undone.`,
    )
    if (!confirmed) return

    setDeleting(true)
    setError('')
    setSaved(false)
    try {
      await api.delete(`/stations/${station.id}`)
      router.push('/dashboard')
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Failed to delete station')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <div
        className="sticky top-0 z-40 px-5 py-3 flex items-center justify-between"
        style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)' }}
      >
        <Button variant="ghost" size="sm" onClick={() => router.push(`/station/${code}`)}>
          <ArrowLeft size={14} />
          Back
        </Button>
        <p className="text-sm font-semibold text-[--text-primary] tracking-wide">Station Settings</p>
        <div className="w-[68px]" />
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6">
        {loading ? (
          <div className="h-52 flex items-center justify-center">
            <div className="w-7 h-7 border-2 border-[--color-accent] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error && !station ? (
          <div className="rounded-2xl p-5 text-sm text-red-300" style={{ background: 'rgba(239,68,68,0.12)' }}>
            {error}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
            <motion.section
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="md:col-span-4 rounded-2xl p-4"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
            >
              <div className="flex items-center gap-2 mb-3">
                <Radio size={14} className="text-[--color-accent]" />
                <p className="text-xs uppercase tracking-[0.14em] text-[--text-muted]">Identity</p>
              </div>
              <div className="space-y-3">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={60}
                  placeholder="Station name"
                  className="w-full h-11 px-3 rounded-xl text-sm text-[--text-primary] placeholder:text-[--text-muted] focus:outline-none"
                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}
                />
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={300}
                  rows={3}
                  placeholder="Description"
                  className="w-full px-3 py-2.5 rounded-xl text-sm text-[--text-primary] placeholder:text-[--text-muted] focus:outline-none resize-none"
                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}
                />
              </div>
            </motion.section>

            <motion.section
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.03 }}
              className="md:col-span-2 rounded-2xl p-4"
              style={{
                background: 'linear-gradient(160deg, rgba(232,68,15,0.18), rgba(232,68,15,0.06))',
                border: '1px solid rgba(232,68,15,0.35)',
              }}
            >
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheck size={14} className="text-[--color-accent]" />
                <p className="text-xs uppercase tracking-[0.14em] text-[--text-muted]">Access</p>
              </div>
              <div className="space-y-2">
              {ACCESS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setAccessMode(opt.value)}
                    className="w-full text-left rounded-xl px-3 py-2 transition-colors"
                    style={{
                      background: accessMode === opt.value ? 'var(--bg-inset)' : 'rgba(0,0,0,0.12)',
                      border: `1px solid ${accessMode === opt.value ? 'var(--color-accent)' : 'var(--border)'}`,
                    }}
                  >
                    <p className="text-sm font-medium text-[--text-primary]">{opt.label}</p>
                    <p className="text-[11px] text-[--text-muted] mt-0.5">{opt.hint}</p>
                  </button>
                ))}
              </div>
            </motion.section>

            <motion.section
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.06 }}
              className="md:col-span-3 rounded-2xl p-4"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
            >
              <div className="flex items-center gap-2 mb-3">
                <Lock size={14} className="text-[--color-accent]" />
                <p className="text-xs uppercase tracking-[0.14em] text-[--text-muted]">Password</p>
              </div>
              <button
                type="button"
                onClick={() => setPasswordEnabled((v) => !v)}
                className="w-full h-11 rounded-xl px-3 flex items-center justify-between"
                style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}
              >
                <span className="text-sm font-medium text-[--text-primary]">Password protection</span>
                <span className="text-xs text-[--text-muted]">{passwordEnabled ? 'Enabled' : 'Disabled'}</span>
              </button>
              {passwordEnabled ? (
                <div className="space-y-2">
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={hasPasswordAlready ? 'Enter new password (optional)' : 'Set password (min 4 chars)'}
                    className="w-full h-11 px-3 rounded-xl text-sm text-[--text-primary] placeholder:text-[--text-muted] focus:outline-none"
                    style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}
                  />
                  <p className="text-[11px] text-[--text-muted]">
                    {hasPasswordAlready
                      ? 'Password is already enabled. Leave empty to keep current password.'
                      : 'Required when password protection is enabled.'}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-[--text-muted]">Password protection is disabled.</p>
              )}
            </motion.section>

            <motion.section
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.09 }}
              className="md:col-span-3 rounded-2xl p-4"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
            >
              <p className="text-xs uppercase tracking-[0.14em] text-[--text-muted] mb-2">Playback</p>
              <p className="text-sm text-[--text-secondary]">
                Crossfade is fixed at 3 seconds by default.
              </p>
            </motion.section>

            <motion.section
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.12 }}
              className="md:col-span-6 rounded-2xl p-4"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
            >
              <div className="flex items-center gap-2 mb-3">
                <Sparkles size={14} className="text-[--color-accent]" />
                <p className="text-xs uppercase tracking-[0.14em] text-[--text-muted]">Summary</p>
              </div>
              <p className="text-sm text-[--text-secondary]">
                Configure station availability and password protection independently.
              </p>
              {error && (
                <p className="mt-3 text-sm text-red-300">{error}</p>
              )}
              {saved && (
                <p className="mt-3 text-sm text-[#7EE787]">Settings updated successfully.</p>
              )}
              <div className="mt-4 flex items-center gap-2">
                <Button variant="secondary" onClick={() => router.push(`/station/${code}`)}>
                  Cancel
                </Button>
                <Button onClick={handleSave} disabled={!canSave || saving} isLoading={saving}>
                  Save Settings
                </Button>
              </div>
            </motion.section>

            <motion.section
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.14 }}
              className="md:col-span-6 rounded-2xl p-4"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
            >
              <p className="text-4xl font-black text-[--text-primary] tracking-tight leading-none mb-4">
                Danger Zone
              </p>
              <p className="text-sm text-[--text-muted] mb-4">
                Remove this station completely with its queue, tracks and settings.
              </p>
              <Button variant="danger" className="!pl-0 pr-4 justify-start !bg-transparent hover:!bg-transparent" onClick={handleDeleteStation} isLoading={deleting}>
                <X size={14} />
                Delete Station
              </Button>
            </motion.section>
          </div>
        )}
      </div>
    </div>
  )
}
