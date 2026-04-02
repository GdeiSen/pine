'use client'

import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { formatDuration } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { TrackCoverImage } from '@/components/ui/track-cover-image'
import { buildTrackCoverUrl } from '@/lib/media-url'
import { UploadModal } from './upload-modal'
import api from '@/lib/api'
import {
  Upload, Plus, ChevronDown, Music2, Play, ListMusic, Check, MoreHorizontal,
} from 'lucide-react'

interface Playlist {
  id: string
  name: string
  trackCount: number
  totalDuration: number
  isDefault: boolean
  sortOrder: number
}

interface Track {
  id: string
  title: string | null
  artist: string | null
  duration: number
  hasCover: boolean
}

interface LibraryPanelProps {
  stationId: string
  stationCode: string
  activePlaylistId: string | null
  canControl: boolean
  onAddToQueue: (trackId: string) => void
}

// Simple dropdown context menu
function TrackMenu({
  track,
  onAddToQueue,
  onClose,
}: {
  track: Track
  onAddToQueue: (trackId: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.95, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: -4 }}
      transition={{ duration: 0.12 }}
      className="absolute right-0 top-7 z-50 min-w-[160px] rounded-xl overflow-hidden"
      style={{ boxShadow: 'var(--shadow-lg)', background: 'var(--bg-elevated)' }}
    >
      <button
        className="flex items-center gap-2.5 w-full px-3 py-2.5 text-sm text-[--text-primary] hover:bg-[--bg-subtle] transition-colors"
        onClick={() => { onAddToQueue(track.id); onClose() }}
      >
        <Play size={13} className="text-[--color-accent]" />
        Add to queue
      </button>
    </motion.div>
  )
}

function PlaylistRow({
  playlist,
  isActive,
  stationId,
  canControl,
  onAddToQueue,
  onActivate,
}: {
  playlist: Playlist
  isActive: boolean
  stationId: string
  canControl: boolean
  onAddToQueue: (trackId: string) => void
  onActivate: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [openMenuTrackId, setOpenMenuTrackId] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: tracks = [], refetch: refetchTracks } = useQuery<Track[]>({
    queryKey: ['playlist-tracks', playlist.id],
    queryFn: () => api.get(`/playlists/${playlist.id}/tracks`).then((r) => r.data),
    enabled: expanded,
  })

  return (
    <>
      <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-sm)' }}>
        {/* Header */}
        <div
          className="flex items-center gap-3 px-4 py-3.5 cursor-pointer hover:bg-[--bg-subtle] transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'var(--bg-inset)' }}>
            <ListMusic size={15} className="text-[--text-muted]" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-[--text-primary] truncate">{playlist.name}</span>
              {isActive && <Badge variant="accent" className="text-[10px]">Active</Badge>}
            </div>
            <p className="text-xs text-[--text-muted] mt-0.5">
              {playlist.trackCount} track{playlist.trackCount !== 1 ? 's' : ''}
              {playlist.totalDuration > 0 && ` · ${formatDuration(playlist.totalDuration)}`}
            </p>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            {canControl && !isActive && (
              <Button size="icon-sm" variant="ghost" onClick={() => onActivate(playlist.id)} title="Set as active">
                <Play size={12} />
              </Button>
            )}
            {canControl && (
              <Button size="icon-sm" variant="ghost" onClick={() => { setExpanded(true); setShowUpload(true) }} title="Upload tracks">
                <Upload size={12} />
              </Button>
            )}
            <motion.div animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.2 }}>
              <ChevronDown size={14} className="text-[--text-muted]" />
            </motion.div>
          </div>
        </div>

        {/* Track list */}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div style={{ borderTop: '1px solid var(--border)' }}>
                {tracks.length === 0 ? (
                  <div className="flex flex-col items-center py-8 text-[--text-muted]">
                    <Music2 size={20} className="mb-1.5 opacity-30" />
                    <p className="text-xs">No tracks yet</p>
                    {canControl && (
                      <Button size="sm" variant="ghost" className="mt-2 text-xs" onClick={() => setShowUpload(true)}>
                        <Upload size={12} /> Upload
                      </Button>
                    )}
                  </div>
                ) : (
                  <div>
                    {tracks.map((track, i) => {
                      const coverUrl = track.hasCover ? buildTrackCoverUrl(track.id) : null
                      return (
                        <div
                          key={track.id}
                          className="relative flex items-center gap-3 px-4 py-2.5 hover:bg-[--bg-subtle] transition-colors"
                        >
                          <span className="text-[11px] text-[--text-muted] w-4 text-right flex-shrink-0 tabular-nums">
                            {i + 1}
                          </span>
                          <div
                            className="w-7 h-7 rounded-lg overflow-hidden flex-shrink-0"
                            style={{
                              background: coverUrl
                                ? "var(--bg-inset)"
                                : "rgba(128, 128, 128, 0.2)",
                            }}
                          >
                            <TrackCoverImage
                              src={coverUrl}
                              fallbackIconSize={11}
                              fallbackClassName="w-full h-full flex items-center justify-center"
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-[--text-primary] truncate">{track.title ?? track.id}</p>
                            <p className="text-[10px] text-[--text-muted] truncate">{track.artist ?? '—'}</p>
                          </div>
                          <span className="text-[11px] text-[--text-muted] flex-shrink-0 tabular-nums">
                            {formatDuration(track.duration)}
                          </span>

                          {/* 3-dot menu */}
                          <div className="relative flex-shrink-0">
                            <button
                              className="flex items-center justify-center w-6 h-6 rounded-lg text-[--text-muted] hover:text-[--text-primary] hover:bg-[--bg-inset] transition-colors"
                              onClick={(e) => {
                                e.stopPropagation()
                                setOpenMenuTrackId(openMenuTrackId === track.id ? null : track.id)
                              }}
                            >
                              <MoreHorizontal size={13} />
                            </button>
                            <AnimatePresence>
                              {openMenuTrackId === track.id && (
                                <TrackMenu
                                  track={track}
                                  onAddToQueue={onAddToQueue}
                                  onClose={() => setOpenMenuTrackId(null)}
                                />
                              )}
                            </AnimatePresence>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {showUpload && (
          <UploadModal
            stationId={stationId}
            playlistId={playlist.id}
            onClose={() => setShowUpload(false)}
            onUploaded={() => {
              refetchTracks()
              queryClient.invalidateQueries({ queryKey: ['playlists', stationId] })
            }}
          />
        )}
      </AnimatePresence>
    </>
  )
}

export function LibraryPanel({
  stationId,
  stationCode,
  activePlaylistId,
  canControl,
  onAddToQueue,
}: LibraryPanelProps) {
  const [showNewPlaylist, setShowNewPlaylist] = useState(false)
  const [newName, setNewName] = useState('')
  const queryClient = useQueryClient()

  const { data: playlists = [], isLoading } = useQuery<Playlist[]>({
    queryKey: ['playlists', stationId],
    queryFn: () => api.get(`/stations/${stationId}/playlists`).then((r) => r.data),
    enabled: !!stationId,
  })

  const createMutation = useMutation({
    mutationFn: (name: string) => api.post(`/stations/${stationId}/playlists`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists', stationId] })
      setNewName('')
      setShowNewPlaylist(false)
    },
  })

  const activateMutation = useMutation({
    mutationFn: (playlistId: string) =>
      api.post(`/stations/${stationId}/playlists/${playlistId}/activate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists', stationId] })
    },
  })

  if (!stationId) return null

  return (
    <div className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold text-[--text-muted] uppercase tracking-widest">Playlists</p>
        {canControl && (
          <Button size="icon-sm" variant="ghost" onClick={() => setShowNewPlaylist(!showNewPlaylist)}>
            <Plus size={14} />
          </Button>
        )}
      </div>

      {/* New playlist input */}
      <AnimatePresence>
        {showNewPlaylist && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="flex gap-2 pb-1">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim()) createMutation.mutate(newName.trim())
                  if (e.key === 'Escape') setShowNewPlaylist(false)
                }}
                placeholder="Playlist name…"
                className="flex-1 h-9 px-3 rounded-xl text-sm text-[--text-primary] placeholder:text-[--text-muted] focus:outline-none transition-colors"
                style={{
                  background: 'var(--bg-subtle)',
                  border: '1.5px solid var(--border)',
                }}
              />
              <Button
                size="icon"
                onClick={() => newName.trim() && createMutation.mutate(newName.trim())}
                disabled={!newName.trim()}
                isLoading={createMutation.isPending}
              >
                <Check size={14} />
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-8">
          <div className="w-5 h-5 border-2 border-[--color-accent] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : playlists.length === 0 ? (
        <div className="flex flex-col items-center py-12 text-[--text-muted]">
          <ListMusic size={24} className="mb-2 opacity-30" />
          <p className="text-sm">No playlists yet</p>
          {canControl && (
            <Button size="sm" variant="ghost" className="mt-3 text-xs" onClick={() => setShowNewPlaylist(true)}>
              <Plus size={12} /> Create playlist
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {playlists.map((playlist) => (
            <PlaylistRow
              key={playlist.id}
              playlist={playlist}
              isActive={playlist.id === activePlaylistId}
              stationId={stationId}
              canControl={canControl}
              onAddToQueue={onAddToQueue}
              onActivate={(id) => activateMutation.mutate(id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
