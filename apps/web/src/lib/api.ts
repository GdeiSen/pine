import axios from 'axios'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api'

export const api = axios.create({
  baseURL: API_URL,
  withCredentials: true,
})

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
