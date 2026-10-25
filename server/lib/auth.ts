/**
 * Optional HTTP Basic auth gate for hosted verification deployments.
 *
 * Enabled only when both BASIC_AUTH_USER and BASIC_AUTH_PASSWORD are set.
 * A successful Basic challenge also sets an HttpOnly cookie so the WebSocket
 * upgrade (which browsers send with cookies but not always with the cached
 * Authorization header) and later page loads pass without re-prompting.
 * The cookie is an HMAC over the user name keyed by the password, so it is
 * invalidated by changing either value. No sessions, no storage.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export const AUTH_COOKIE = 'mvp_auth'
export const AUTH_COOKIE_MAX_AGE_S = 12 * 3600
/** Paths that stay reachable without credentials (platform health checks). */
export const AUTH_EXEMPT_PATHS: ReadonlySet<string> = new Set(['/healthz'])

export interface AuthSettings {
  basicAuthUser: string
  basicAuthPassword: string
}

export type AuthResult = 'open' | 'cookie' | 'basic' | 'unauthorized'

export const authEnabled = (s: AuthSettings): boolean => Boolean(s.basicAuthUser && s.basicAuthPassword)

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

export function cookieToken(s: AuthSettings): string {
  return createHmac('sha256', `cookie:${s.basicAuthPassword}`).update(s.basicAuthUser).digest('hex')
}

export function parseBasic(header: string | null | undefined): { user: string; password: string } | null {
  if (!header) return null
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim())
  if (!m) return null
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8')
  const i = decoded.indexOf(':')
  if (i < 0) return null
  return { user: decoded.slice(0, i), password: decoded.slice(i + 1) }
}

export function cookieValue(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=')
  }
  return null
}

/** Pure decision: which credential (if any) admits this request. */
export function checkAuth(headers: { authorization?: string | null; cookie?: string | null }, s: AuthSettings): AuthResult {
  if (!authEnabled(s)) return 'open'
  const c = cookieValue(headers.cookie, AUTH_COOKIE)
  if (c && safeEqual(c, cookieToken(s))) return 'cookie'
  const b = parseBasic(headers.authorization)
  if (b && safeEqual(b.user, s.basicAuthUser) && safeEqual(b.password, s.basicAuthPassword)) return 'basic'
  return 'unauthorized'
}
