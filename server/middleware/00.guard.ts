// Host / Origin / content-type / size guards for every HTTP request (local-only MVP).
import { defineEventHandler, getRequestHeader, setResponseHeader } from 'h3'
import { httpError } from '../lib/api'
import { services } from '../lib/services'

export default defineEventHandler((event) => {
  const svc = services()
  const host = getRequestHeader(event, 'host') ?? ''
  if (!svc.allowedHosts.has(host)) throw httpError(421, 'host not allowed')
  const m = event.method
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
    const origin = getRequestHeader(event, 'origin') ?? ''
    if (!svc.allowedOrigins.has(origin)) throw httpError(403, 'cross-origin request rejected')
    if (!(getRequestHeader(event, 'content-type') ?? '').startsWith('application/json')) throw httpError(415, 'application/json required')
    const cl = getRequestHeader(event, 'content-length')
    if (!cl || !/^\d+$/.test(cl) || Number(cl) > svc.settings.maxHttpBodyBytes) throw httpError(413, 'body too large or length missing')
  }
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  setResponseHeader(event, 'X-Frame-Options', 'DENY')
  if (!event.path.startsWith('/api/') && !event.path.startsWith('/_nuxt/')) {
    // dev mode needs inline bootstrap scripts; in production the built page is self-hosted
    setResponseHeader(event, 'Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
  }
})
