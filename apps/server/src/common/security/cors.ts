const DEFAULT_CLIENT_ORIGIN = 'http://localhost:3000'

const normalizeOrigin = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) return ''

  try {
    const parsed = new URL(trimmed)
    return `${parsed.protocol}//${parsed.host}`.toLowerCase()
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase()
  }
}

export const resolveAllowedOrigins = (
  rawAllowedOrigins?: string | null,
  fallbackClientOrigin?: string | null,
): string[] => {
  const items = (rawAllowedOrigins ?? '')
    .split(',')
    .map((item) => normalizeOrigin(item))
    .filter(Boolean)

  const fallback = normalizeOrigin(fallbackClientOrigin ?? DEFAULT_CLIENT_ORIGIN)
  if (fallback) items.push(fallback)

  return Array.from(new Set(items))
}

export const isAllowedOrigin = (origin: string | undefined, allowedOrigins: string[]): boolean => {
  if (!origin) return true
  const normalized = normalizeOrigin(origin)
  return allowedOrigins.includes(normalized)
}

