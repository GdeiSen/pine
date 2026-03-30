import { io, Socket } from 'socket.io-client'
import { resolveConfiguredOrigin } from '@/lib/origin'

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? ''

let socket: Socket | null = null

export function getSocket(): Socket {
  if (!socket) {
    const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') : null
    const socketBaseUrl = resolveConfiguredOrigin(SOCKET_URL)
    socket = io(socketBaseUrl ? `${socketBaseUrl}/station` : '/station', {
      auth: { token: token ?? '' },
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
    })
  }
  return socket
}

export function updateSocketToken(token: string) {
  if (socket) {
    socket.auth = { token }
    socket.disconnect().connect()
  }
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect()
    socket = null
  }
}
