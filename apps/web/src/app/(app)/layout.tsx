'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useAuthStore } from '@/stores/auth.store'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const user = useAuthStore((s) => s.user)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const refreshUser = useAuthStore((s) => s.refreshUser)
  const [isCheckingAccess, setIsCheckingAccess] = useState(true)

  const needsGuestCheck = useMemo(() => pathname.startsWith('/station/'), [pathname])
  const isStationSettings = useMemo(
    () => pathname.startsWith('/station/') && pathname.includes('/settings'),
    [pathname],
  )

  useEffect(() => {
    let cancelled = false

    const runGuard = async () => {
      const token = localStorage.getItem('access_token')

      if (!token) {
        if (!cancelled) {
          if (needsGuestCheck && !isStationSettings) {
            setIsCheckingAccess(false)
            return
          }
          router.replace('/login')
          setIsCheckingAccess(false)
        }
        return
      }

      if (isAuthenticated && user) {
        if (!cancelled) setIsCheckingAccess(false)
        return
      }

      try {
        await refreshUser()
        if (!cancelled) setIsCheckingAccess(false)
      } catch {
        localStorage.removeItem('access_token')
        useAuthStore.setState({ user: null, isAuthenticated: false, accessToken: null })
        if (!cancelled) {
          if (needsGuestCheck && !isStationSettings) {
            setIsCheckingAccess(false)
            return
          }
          router.replace('/login')
          setIsCheckingAccess(false)
        }
      }
    }

    runGuard()

    return () => {
      cancelled = true
    }
  }, [pathname, router, user, isAuthenticated, refreshUser, needsGuestCheck, isStationSettings])

  if (isCheckingAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="w-7 h-7 border-2 border-[--color-accent] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return <>{children}</>
}
