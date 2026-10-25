import { describe, expect, it } from 'vitest'
import { AUTH_COOKIE, AUTH_EXEMPT_PATHS, authEnabled, checkAuth, cookieToken, cookieValue, parseBasic } from '../server/lib/auth'

const S = { basicAuthUser: 'tester', basicAuthPassword: 'pa:ss word' }
const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64')

describe('basic auth gate', () => {
  it('disabled unless both user and password are set', () => {
    expect(authEnabled({ basicAuthUser: '', basicAuthPassword: '' })).toBe(false)
    expect(authEnabled({ basicAuthUser: 'u', basicAuthPassword: '' })).toBe(false)
    expect(checkAuth({}, { basicAuthUser: '', basicAuthPassword: 'p' })).toBe('open')
    expect(authEnabled(S)).toBe(true)
  })

  it('parses Basic headers (password may contain colons) and cookies', () => {
    expect(parseBasic(basic('a', 'b:c'))).toEqual({ user: 'a', password: 'b:c' })
    expect(parseBasic('Bearer x')).toBeNull(); expect(parseBasic('Basic !!!')).toBeNull(); expect(parseBasic(undefined)).toBeNull()
    expect(cookieValue(`x=1; ${AUTH_COOKIE}=abc=def; y=2`, AUTH_COOKIE)).toBe('abc=def')
    expect(cookieValue('x=1', AUTH_COOKIE)).toBeNull()
  })

  it('accepts the right Basic credentials or the derived cookie only', () => {
    expect(checkAuth({}, S)).toBe('unauthorized')
    expect(checkAuth({ authorization: basic('tester', 'wrong') }, S)).toBe('unauthorized')
    expect(checkAuth({ authorization: basic('other', 'pa:ss word') }, S)).toBe('unauthorized')
    expect(checkAuth({ authorization: basic('tester', 'pa:ss word') }, S)).toBe('basic')
    const tok = cookieToken(S)
    expect(tok).toMatch(/^[0-9a-f]{64}$/)
    expect(checkAuth({ cookie: `${AUTH_COOKIE}=${tok}` }, S)).toBe('cookie')
    expect(checkAuth({ cookie: `${AUTH_COOKIE}=${tok.slice(0, -1)}0` }, S)).toBe('unauthorized')
    expect(cookieToken({ ...S, basicAuthPassword: 'changed' })).not.toBe(tok)
    expect(AUTH_EXEMPT_PATHS.has('/healthz')).toBe(true)
  })
})
