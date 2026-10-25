// Optional Basic auth gate (hosted verification only). Runs after 00.guard.
import { defineEventHandler, getRequestHeader, setCookie, setResponseHeader } from 'h3'
import { httpError } from '../lib/api'
import { AUTH_COOKIE, AUTH_COOKIE_MAX_AGE_S, AUTH_EXEMPT_PATHS, authEnabled, checkAuth, cookieToken } from '../lib/auth'
import { services } from '../lib/services'

export default defineEventHandler((event) => {
  const svc = services()
  if (!authEnabled(svc.settings)) return
  if (AUTH_EXEMPT_PATHS.has(event.path.split('?')[0]!)) return
  const result = checkAuth({ authorization: getRequestHeader(event, 'authorization'), cookie: getRequestHeader(event, 'cookie') }, svc.settings)
  if (result === 'unauthorized') {
    setResponseHeader(event, 'WWW-Authenticate', 'Basic realm="audio-stroke", charset="UTF-8"')
    throw httpError(401, 'authentication required')
  }
  if (result === 'basic') {
    const secure = (getRequestHeader(event, 'x-forwarded-proto') ?? '').split(',')[0]!.trim() === 'https'
    setCookie(event, AUTH_COOKIE, cookieToken(svc.settings), { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: AUTH_COOKIE_MAX_AGE_S })
  }
})
