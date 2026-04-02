export function normalizeTrackStartedAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

export function getServerOffsetMs(serverTime?: string | null, referenceTimeMs = Date.now()): number | null {
  if (!serverTime) return null
  const serverTimeMs = Date.parse(serverTime)
  if (Number.isNaN(serverTimeMs)) return null
  return serverTimeMs - referenceTimeMs
}

export function getEstimatedServerPosition(args: {
  currentPosition?: number
  duration?: number | null
  isPaused: boolean
  pausedPosition?: number
  serverOffsetMs: number | null
  trackStartedAt?: number | null
}) {
  const {
    currentPosition = 0,
    duration,
    isPaused,
    pausedPosition = 0,
    serverOffsetMs,
    trackStartedAt,
  } = args

  const clampPosition = (position: number) => {
    if (!Number.isFinite(position)) return 0
    const normalized = Math.max(0, position)
    if (typeof duration === 'number' && duration > 0) {
      return Math.min(normalized, duration)
    }
    return normalized
  }

  if (isPaused) {
    return clampPosition(pausedPosition || currentPosition)
  }

  if (typeof trackStartedAt === 'number' && Number.isFinite(trackStartedAt)) {
    const serverNowMs = Date.now() + (serverOffsetMs ?? 0)
    return clampPosition((serverNowMs - trackStartedAt) / 1000)
  }

  return clampPosition(currentPosition)
}
