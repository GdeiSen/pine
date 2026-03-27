'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'

interface WaveAnimationProps {
  isPlaying: boolean
  isPaused: boolean
  onToggle: () => void
  accentColor?: string
  className?: string
}

const WAVES = [
  { scale: 1.6, opacity: 0.08, delay: 0 },
  { scale: 2.2, opacity: 0.06, delay: 0.3 },
  { scale: 2.9, opacity: 0.04, delay: 0.6 },
  { scale: 3.6, opacity: 0.02, delay: 0.9 },
]

export function WaveAnimation({
  isPlaying,
  isPaused,
  onToggle,
  accentColor = '#6366f1',
  className,
}: WaveAnimationProps) {
  const isActive = isPlaying && !isPaused

  return (
    <div
      className={cn(
        'relative flex items-center justify-center w-full h-full',
        className,
      )}
    >
      {/* Background gradient */}
      <div
        className="absolute inset-0 transition-all duration-1000"
        style={{
          background: isActive
            ? `radial-gradient(ellipse at 50% 80%, ${accentColor}18 0%, transparent 70%)`
            : 'transparent',
        }}
      />

      {/* Animated wave rings */}
      <AnimatePresence>
        {isActive &&
          WAVES.map((wave, i) => (
            <motion.div
              key={i}
              className="absolute rounded-full"
              style={{
                width: 72,
                height: 72,
                backgroundColor: accentColor,
              }}
              initial={{ scale: 1, opacity: 0 }}
              animate={{
                scale: [1, wave.scale],
                opacity: [wave.opacity * 2, 0],
              }}
              transition={{
                duration: 2.4,
                repeat: Infinity,
                delay: wave.delay,
                ease: 'easeOut',
              }}
            />
          ))}
      </AnimatePresence>

      {/* Equalizer bars (visible when playing) */}
      <div className="absolute top-1/3 flex items-end gap-1 h-6">
        {isActive
          ? [0, 1, 2, 3, 4].map((i) => (
              <motion.div
                key={i}
                className="w-0.5 rounded-full"
                style={{ backgroundColor: accentColor }}
                animate={{
                  height: ['40%', '100%', '60%', '80%', '40%'],
                }}
                transition={{
                  duration: 0.8,
                  repeat: Infinity,
                  delay: i * 0.12,
                  ease: 'easeInOut',
                }}
              />
            ))
          : [0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="w-0.5 h-1 rounded-full"
                style={{ backgroundColor: accentColor, opacity: 0.3 }}
              />
            ))}
      </div>

      {/* Central play/pause button */}
      <motion.button
        onClick={onToggle}
        className={cn(
          'relative z-10 flex items-center justify-center',
          'w-[72px] h-[72px] rounded-full',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30',
          'transition-all duration-200',
        )}
        style={{
          backgroundColor: accentColor,
          boxShadow: isActive
            ? `0 0 32px ${accentColor}60, 0 0 64px ${accentColor}20`
            : `0 0 16px ${accentColor}30`,
        }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
      >
        <AnimatePresence mode="wait">
          {isActive ? (
            <motion.svg
              key="pause"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="white"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.5, opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <rect x="6" y="4" width="4" height="16" rx="2" />
              <rect x="14" y="4" width="4" height="16" rx="2" />
            </motion.svg>
          ) : (
            <motion.svg
              key="play"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="white"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.5, opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <path d="M8 5.14v14l11-7-11-7z" />
            </motion.svg>
          )}
        </AnimatePresence>
      </motion.button>

      {/* Pulse ring on button when active */}
      {isActive && (
        <motion.div
          className="absolute rounded-full pointer-events-none"
          style={{
            width: 72,
            height: 72,
            border: `2px solid ${accentColor}`,
          }}
          animate={{ scale: [1, 1.3], opacity: [0.6, 0] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: 'easeOut' }}
        />
      )}
    </div>
  )
}
