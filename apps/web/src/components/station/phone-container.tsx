'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { AudioBars } from './audio-bars'
import { cn } from '@/lib/utils'

interface PlayerContainerProps {
  isPlaying: boolean
  isPaused: boolean
  onToggle: () => void
  coverUrl?: string | null
  accentColor?: string
  stationName?: string
  trackTitle?: string | null
  artist?: string | null
  className?: string
}

// Concentric wave rings emanating from the play button
const WAVES = [
  { delay: 0,    scale: 1.5, opacity: 0.12 },
  { delay: 0.35, scale: 2.2, opacity: 0.08 },
  { delay: 0.7,  scale: 3.1, opacity: 0.05 },
  { delay: 1.05, scale: 4.2, opacity: 0.025 },
]

export function PhoneContainer({
  isPlaying,
  isPaused,
  onToggle,
  coverUrl,
  accentColor = '#E8440F',
  stationName,
  trackTitle,
  artist,
  className,
}: PlayerContainerProps) {
  const isActive = isPlaying && !isPaused

  return (
    <motion.div
      className={cn(
        'relative flex flex-col items-center justify-between overflow-hidden',
        'w-[320px] rounded-[32px]',
        'bg-[--bg-elevated] border border-[--border]',
        'shadow-[0_24px_64px_rgba(0,0,0,0.12)]',
        className,
      )}
      style={{ height: 480 }}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* Dynamic color background based on accent */}
      <motion.div
        className="absolute inset-0 pointer-events-none"
        animate={{
          background: isActive
            ? `radial-gradient(ellipse 70% 60% at 50% 90%, ${accentColor}20 0%, transparent 70%)`
            : 'transparent',
        }}
        transition={{ duration: 0.8 }}
      />

      {/* Cover art blurred into background */}
      {coverUrl && (
        <div
          className="absolute inset-0 opacity-10 bg-cover bg-center scale-110 blur-2xl pointer-events-none"
          style={{ backgroundImage: `url(${coverUrl})` }}
        />
      )}

      {/* Top: station name + audio bars */}
      <div className="relative z-10 w-full px-7 pt-7">
        <div className="flex items-center justify-between mb-5">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[--text-muted]">
              Now Playing
            </p>
            <p className="text-sm font-semibold text-[--text-secondary] mt-0.5 truncate max-w-[180px]">
              {stationName ?? 'Station'}
            </p>
          </div>
          <AudioBars isActive={isActive} barCount={7} color={accentColor} height={28} />
        </div>

        {/* Cover art */}
        <AnimatePresence mode="wait">
          <motion.div
            key={coverUrl ?? 'no-cover'}
            className="w-full rounded-2xl overflow-hidden"
            style={{ height: 140 }}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.3 }}
          >
            {coverUrl ? (
              <img src={coverUrl} alt="Cover" className="w-full h-full object-cover" />
            ) : (
              <div
                className="w-full h-full flex items-center justify-center"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(128, 128, 128, 0.22), rgba(128, 128, 128, 0.08))",
                }}
              >
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="1.2" opacity="0.4" className="text-[--text-muted]">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        {/* Track title */}
        <div className="mt-4">
          <AnimatePresence mode="wait">
            <motion.p
              key={trackTitle}
              className="text-xl font-bold text-[--text-primary] leading-tight truncate"
              style={{ letterSpacing: '-0.4px' }}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
            >
              {trackTitle ?? 'No track playing'}
            </motion.p>
          </AnimatePresence>
          <AnimatePresence mode="wait">
            <motion.p
              key={artist}
              className="text-sm text-[--text-secondary] mt-0.5 truncate"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.2, delay: 0.05 }}
            >
              {artist ?? '—'}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>

      {/* Bottom: wave rings + play button */}
      <div className="relative z-10 w-full flex items-end justify-center pb-8" style={{ height: 140 }}>

        {/* Concentric wave rings */}
        <AnimatePresence>
          {isActive && WAVES.map((wave, i) => (
            <motion.div
              key={i}
              className="absolute rounded-full pointer-events-none"
              style={{
                width: 64,
                height: 64,
                backgroundColor: accentColor,
                bottom: 32,
              }}
              initial={{ scale: 1, opacity: 0 }}
              animate={{ scale: wave.scale, opacity: [wave.opacity * 1.5, 0] }}
              transition={{
                duration: 2.2,
                repeat: Infinity,
                delay: wave.delay,
                ease: 'easeOut',
              }}
            />
          ))}
        </AnimatePresence>

        {/* Play / Pause button */}
        <motion.button
          onClick={onToggle}
          className="relative z-10 w-16 h-16 rounded-full flex items-center justify-center focus:outline-none"
          style={{
            backgroundColor: accentColor,
            boxShadow: isActive
              ? `0 0 0 0px ${accentColor}00, 0 8px 32px ${accentColor}50`
              : `0 4px 20px ${accentColor}35`,
          }}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.93 }}
          transition={{ type: 'spring', stiffness: 400, damping: 20 }}
        >
          <AnimatePresence mode="wait">
            {isActive ? (
              <motion.svg key="pause" width="22" height="22" viewBox="0 0 24 24" fill="white"
                initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.5, opacity: 0 }} transition={{ duration: 0.1 }}>
                <rect x="6" y="4" width="4" height="16" rx="2" />
                <rect x="14" y="4" width="4" height="16" rx="2" />
              </motion.svg>
            ) : (
              <motion.svg key="play" width="22" height="22" viewBox="0 0 24 24" fill="white"
                initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.5, opacity: 0 }} transition={{ duration: 0.1 }}>
                <path d="M8 5.14v14l11-7-11-7z" />
              </motion.svg>
            )}
          </AnimatePresence>
        </motion.button>

        {/* Pulse ring */}
        {isActive && (
          <motion.div
            className="absolute rounded-full pointer-events-none"
            style={{ width: 64, height: 64, border: `1.5px solid ${accentColor}`, bottom: 32 }}
            animate={{ scale: [1, 1.28], opacity: [0.7, 0] }}
            transition={{ duration: 1.0, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
      </div>
    </motion.div>
  )
}
