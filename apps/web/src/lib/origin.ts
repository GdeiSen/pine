'use client'

export function isLoopbackHost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0'
}

export function resolveConfiguredOrigin(configuredUrl: string) {
  if (!configuredUrl || typeof window === 'undefined') return configuredUrl

  try {
    const configured = new URL(configuredUrl, window.location.origin)
    if (isLoopbackHost(configured.hostname) && !isLoopbackHost(window.location.hostname)) {
      configured.protocol = window.location.protocol
      configured.hostname = window.location.hostname
      return configured.origin
    }
    return configured.origin
  } catch {
    return configuredUrl
  }
}
