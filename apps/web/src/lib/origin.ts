'use client'

export function isLoopbackHost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0'
}

export function resolveConfiguredOrigin(configuredUrl: string) {
  if (!configuredUrl || typeof window === 'undefined') return configuredUrl

  try {
    const configured = new URL(configuredUrl, window.location.origin)
    if (isLoopbackHost(configured.hostname) && !isLoopbackHost(window.location.hostname)) {
      // If a localhost-only URL leaks into a public build, prefer the
      // current public origin instead of keeping an internal-only port.
      return window.location.origin
    }
    return configured.origin
  } catch {
    return configuredUrl
  }
}
