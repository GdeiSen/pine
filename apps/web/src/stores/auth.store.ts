import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import api from '@/lib/api'

interface User {
  id: string
  email: string
  username: string
  avatar: string | null
  storage?: {
    usedBytes: number
    limitBytes: number
    availableBytes: number
  }
}

interface AuthState {
  user: User | null
  accessToken: string | null
  isAuthenticated: boolean
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refreshUser: () => Promise<void>
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      isAuthenticated: false,
      isLoading: false,

      login: async (email, password) => {
        const res = await api.post('/auth/login', { email, password })
        const { accessToken, user } = res.data
        localStorage.setItem('access_token', accessToken)
        set({ user, accessToken, isAuthenticated: true })
      },

      register: async (email, username, password) => {
        const res = await api.post('/auth/register', { email, username, password })
        const { accessToken, user } = res.data
        localStorage.setItem('access_token', accessToken)
        set({ user, accessToken, isAuthenticated: true })
      },

      logout: async () => {
        await api.post('/auth/logout').catch(() => {})
        localStorage.removeItem('access_token')
        set({ user: null, accessToken: null, isAuthenticated: false })
      },

      refreshUser: async () => {
        const res = await api.get('/auth/me')
        set({ user: res.data, isAuthenticated: true })
      },
    }),
    {
      name: 'auth',
      partialize: (state) => ({ user: state.user, isAuthenticated: state.isAuthenticated }),
    },
  ),
)
