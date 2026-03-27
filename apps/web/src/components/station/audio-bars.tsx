'use client'

import { motion } from 'framer-motion'

interface AudioBarsProps {
  isActive: boolean
  barCount?: number
  color?: string
  height?: number
}

const BAR_CONFIGS = [0.3, 0.7, 0.5, 1.0, 0.6, 0.9, 0.4, 0.8, 0.5, 0.7, 0.3]

export function AudioBars({
  isActive,
  barCount = 11,
  color = '#E8440F',
  height = 32,
}: AudioBarsProps) {
  const configs = BAR_CONFIGS.slice(0, barCount)

  return (
    <div
      className="flex items-end justify-center gap-[3px]"
      style={{ height }}
      aria-hidden
    >
      {configs.map((maxH, i) => (
        isActive ? (
          <motion.div
            key={i}
            className="rounded-full flex-shrink-0"
            style={{ width: 3, backgroundColor: color }}
            animate={{
              height: [
                height * 0.15,
                height * maxH,
                height * (maxH * 0.4),
                height * maxH * 0.8,
                height * 0.15,
              ],
            }}
            transition={{
              duration: 1.1 + i * 0.07,
              repeat: Infinity,
              ease: 'easeInOut',
              delay: i * 0.08,
            }}
          />
        ) : (
          <div
            key={i}
            className="rounded-full flex-shrink-0"
            style={{ width: 3, height: height * 0.15, backgroundColor: color, opacity: 0.25 }}
          />
        )
      ))}
    </div>
  )
}
