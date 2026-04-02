import axios from 'axios'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '/api'

export interface StationStreamInfo {
  stationId: string
  code: string
  streamUrl: string
  mountPath: string
  playbackMode?: 'DIRECT' | 'BROADCAST'
  playbackVersion?: number
  serverTime: string
  qualityHint: 'LOW' | 'MEDIUM' | 'HIGH'
  latencyHintMs: number
  currentTrackId: string | null
}

export const api = axios.create({
  baseURL: API_URL,
  withCredentials: true,
})

export async function fetchStationStreamInfo(
  code: string,
  includeAuth = false,
): Promise<StationStreamInfo | null> {
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    }

    if (includeAuth && typeof window !== 'undefined') {
      const token = localStorage.getItem('access_token')
      if (token) {
        headers.Authorization = `Bearer ${token}`
      }
    }

    const response = await fetch(`${API_URL}/stations/${code}/stream-info`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      headers,
    })

    if (!response.ok) return null

    const data = (await response.json().catch(() => null)) as StationStreamInfo | null
    if (!data || typeof data.streamUrl !== 'string') return null

    // Docker-local safety: if backend returns relative mount (e.g. /live.mp3),
    // prefer explicit public stream URL to avoid hitting Next.js (3000) and getting 404.
    if (data.streamUrl.startsWith('/') && data.playbackMode !== 'DIRECT') {
      const explicitPublicStream = process.env.NEXT_PUBLIC_STREAM_URL
      if (explicitPublicStream && /^https?:\/\//i.test(explicitPublicStream)) {
        data.streamUrl = explicitPublicStream
      } else if (typeof window !== 'undefined') {
        data.streamUrl = new URL(data.streamUrl, window.location.origin).toString()
      }
    }

    return data
  } catch {
    return null
  }
}

// Attach token from localStorage
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('access_token')
    if (token) config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Auto-refresh on 401
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config
    const status = error.response?.status
    const message = error.response?.data?.message
    const messageText = Array.isArray(message) ? message.join(' ') : String(message ?? '')
    const requestUrl = String(original?.url ?? '')
    const isStationJoinRequest = requestUrl.includes('/stations/') && requestUrl.endsWith('/join')
    const isPasswordJoinError = /password/i.test(messageText)

    // Do not treat station password checks as auth expiration.
    if (status === 401 && (isStationJoinRequest || isPasswordJoinError)) {
      return Promise.reject(error)
    }

    if (status === 401 && original && !original._retry) {
      original._retry = true
      try {
        const res = await axios.post(`${API_URL}/auth/refresh`, {}, { withCredentials: true })
        const newToken = res.data.accessToken
        localStorage.setItem('access_token', newToken)
        original.headers.Authorization = `Bearer ${newToken}`
        return api(original)
      } catch {
        localStorage.removeItem('access_token')
        if (typeof window !== 'undefined') window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  },
)

export default api
