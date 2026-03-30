'use client'

import { useState, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Upload, CheckCircle2, AlertCircle, Music2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import api from '@/lib/api'
import { SUPPORTED_EXTENSIONS } from '@web-radio/shared'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '/api'

interface UploadFile {
  id: string
  file: File
  status: 'pending' | 'uploading' | 'done' | 'error'
  error?: string
  progress: number
}

interface UploadModalProps {
  stationId: string
  playlistId: string
  onClose: () => void
  onUploaded?: () => void
}

const FALLBACK_BINARY_MIME_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
])

function getFileExtension(name: string) {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return ''
  return name.slice(dot).toLowerCase()
}

function isSupportedAudioUploadFile(file: File) {
  const ext = getFileExtension(file.name)
  const mime = String(file.type ?? '').trim().toLowerCase()
  const isExtAllowed = SUPPORTED_EXTENSIONS.includes(ext)
  if (!isExtAllowed) return false
  return mime.startsWith('audio/') || FALLBACK_BINARY_MIME_TYPES.has(mime)
}

export function UploadModal({ stationId, playlistId, onClose, onUploaded }: UploadModalProps) {
  const [files, setFiles] = useState<UploadFile[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeUploads = useRef(0)

  const addFiles = useCallback((raw: FileList | File[]) => {
    const audio = Array.from(raw).filter(isSupportedAudioUploadFile)
    setFiles((prev) => [
      ...prev,
      ...audio.map((file) => ({
        id: `${file.name}-${Date.now()}-${Math.random()}`,
        file,
        status: 'pending' as const,
        progress: 0,
      })),
    ])
  }, [])

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    addFiles(e.dataTransfer.files)
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(true)
  }

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id))
  }

  async function uploadFile(item: UploadFile) {
    setFiles((prev) =>
      prev.map((f) => (f.id === item.id ? { ...f, status: 'uploading' as const } : f)),
    )

    try {
      const formData = new FormData()
      formData.append('file', item.file)

      await api.post(
        `/stations/${stationId}/tracks/upload?playlistId=${playlistId}`,
        formData,
        {
          headers: { 'Content-Type': 'multipart/form-data' },
          onUploadProgress: (e) => {
            const pct = e.total ? Math.round((e.loaded / e.total) * 100) : 0
            setFiles((prev) =>
              prev.map((f) => (f.id === item.id ? { ...f, progress: pct } : f)),
            )
          },
        },
      )

      setFiles((prev) =>
        prev.map((f) => (f.id === item.id ? { ...f, status: 'done' as const, progress: 100 } : f)),
      )
      onUploaded?.()
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? 'Upload failed'
      setFiles((prev) =>
        prev.map((f) =>
          f.id === item.id ? { ...f, status: 'error' as const, error: msg } : f,
        ),
      )
    }
  }

  async function uploadAll() {
    const pending = files.filter((f) => f.status === 'pending')
    for (const item of pending) {
      await uploadFile(item)
    }
  }

  const hasPending = files.some((f) => f.status === 'pending')
  const allDone = files.length > 0 && files.every((f) => f.status === 'done' || f.status === 'error')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Modal */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 12 }}
        transition={{ duration: 0.2 }}
        className="relative z-10 w-full max-w-lg bg-[--bg-elevated] border border-[--border] rounded-2xl shadow-xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[--border]">
          <div>
            <h2 className="font-semibold text-[--text-primary]">Upload Tracks</h2>
            <p className="text-xs text-[--text-muted] mt-0.5">MP3, FLAC, WAV, AAC supported</p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>

        {/* Drop zone */}
        <div className="p-5">
          <div
            className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer ${
              isDragging
                ? 'border-[--color-accent] bg-[--color-accent]/5'
                : 'border-[--border] hover:border-[--color-accent]/50 hover:bg-[--bg-subtle]/50'
            }`}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={() => setIsDragging(false)}
            onClick={() => inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              accept="audio/*"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && addFiles(e.target.files)}
            />
            <Upload size={28} className="mx-auto mb-2 text-[--text-muted]" />
            <p className="text-sm font-medium text-[--text-secondary]">
              Drop audio files here
            </p>
            <p className="text-xs text-[--text-muted] mt-1">or click to browse</p>
          </div>
        </div>

        {/* File list */}
        {files.length > 0 && (
          <div className="px-5 pb-4 space-y-2 max-h-60 overflow-y-auto">
            {files.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 bg-[--bg-subtle] rounded-xl px-3 py-2.5"
              >
                <Music2 size={14} className="text-[--text-muted] flex-shrink-0" />

                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-[--text-primary] truncate">
                    {item.file.name}
                  </p>
                  {item.status === 'uploading' && (
                    <div className="mt-1 h-1 rounded-full bg-[--border] overflow-hidden">
                      <motion.div
                        className="h-full rounded-full bg-[--color-accent]"
                        style={{ width: `${item.progress}%` }}
                        transition={{ duration: 0.2 }}
                      />
                    </div>
                  )}
                  {item.status === 'error' && (
                    <p className="text-[10px] text-red-400 mt-0.5">{item.error}</p>
                  )}
                </div>

                {/* Status icon */}
                <div className="flex-shrink-0">
                  {item.status === 'pending' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); removeFile(item.id) }}
                      className="text-[--text-muted] hover:text-[--text-primary]"
                    >
                      <X size={12} />
                    </button>
                  )}
                  {item.status === 'uploading' && (
                    <Loader2 size={14} className="text-[--color-accent] animate-spin" />
                  )}
                  {item.status === 'done' && (
                    <CheckCircle2 size={14} className="text-emerald-500" />
                  )}
                  {item.status === 'error' && (
                    <AlertCircle size={14} className="text-red-400" />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-[--border]">
          <p className="text-xs text-[--text-muted]">
            {files.length} file{files.length !== 1 ? 's' : ''} selected
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {allDone ? 'Close' : 'Cancel'}
            </Button>
            {hasPending && (
              <Button size="sm" onClick={uploadAll}>
                <Upload size={13} />
                Upload {files.filter((f) => f.status === 'pending').length} file
                {files.filter((f) => f.status === 'pending').length !== 1 ? 's' : ''}
              </Button>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  )
}
