import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PtpClient } from './client.js'

describe('PtpClient', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  function client() {
    return new PtpClient({ baseUrl: 'https://www.protectthepod.com' })
  }

  describe('validateToken', () => {
    it('returns true when PTP responds 200', async () => {
      fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
      expect(await client().validateToken('good-token')).toBe(true)
    })

    it('returns false when PTP responds 401 (expired/revoked token)', async () => {
      fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
      expect(await client().validateToken('bad-token')).toBe(false)
    })

    it('calls the exact low-stakes read-only endpoint documented in §8.2(d)', async () => {
      fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
      await client().validateToken('a-token')

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://www.protectthepod.com/api/me/drafts?limit=1')
      expect(init.headers.Authorization).toBe('Bearer a-token')
      expect(init.method).toBeUndefined() // defaults to GET — no side effects
    })
  })

  describe('createPod', () => {
    it('returns the parsed pod details on success', async () => {
      const body = { id: 'pod-1', shareId: 'abc123', shareUrl: 'https://www.protectthepod.com/draft/abc123', createdAt: '2026-01-01T00:00:00Z' }
      fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 201 }))

      const result = await client().createPod('a-token', { setCode: 'JTL', maxPlayers: 8 })

      expect(result).toEqual(body)
    })

    it('sends setCode, maxPlayers, and isPublic:true in the request body', async () => {
      fetchMock.mockResolvedValue(new Response('{}', { status: 201 }))

      await client().createPod('a-token', { setCode: 'JTL', maxPlayers: 6 })

      const [, init] = fetchMock.mock.calls[0]
      expect(JSON.parse(init.body)).toEqual({ setCode: 'JTL', maxPlayers: 6, isPublic: true })
    })

    it('throws with the status and response body when PTP rejects the request', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response('User is already in a lobby', { status: 403 }))
      )

      await expect(client().createPod('a-token', { setCode: 'JTL', maxPlayers: 8 })).rejects.toThrow(/403/)
      await expect(client().createPod('a-token', { setCode: 'JTL', maxPlayers: 8 })).rejects.toThrow(
        /already in a lobby/
      )
    })
  })

  describe('refreshToken', () => {
    it('extracts the new JWT from the Set-Cookie header on success', async () => {
      fetchMock.mockResolvedValue(
        new Response('{}', {
          status: 200,
          headers: { 'set-cookie': 'swupod_session=new.jwt.value; Path=/; HttpOnly; Secure' },
        })
      )

      expect(await client().refreshToken('old-token')).toBe('new.jwt.value')
    })

    it('URL-decodes the cookie value', async () => {
      const encoded = encodeURIComponent('token.with special.chars')
      fetchMock.mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'set-cookie': `swupod_session=${encoded}; Path=/` } })
      )

      expect(await client().refreshToken('old-token')).toBe('token.with special.chars')
    })

    it('returns null when the response has no Set-Cookie header', async () => {
      fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
      expect(await client().refreshToken('old-token')).toBeNull()
    })

    it('returns null when Set-Cookie is present but does not contain swupod_session', async () => {
      fetchMock.mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'set-cookie': 'some_other_cookie=value; Path=/' } })
      )
      expect(await client().refreshToken('old-token')).toBeNull()
    })

    it('returns null when PTP responds non-2xx (e.g. the current token already expired)', async () => {
      fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
      expect(await client().refreshToken('expired-token')).toBeNull()
    })

    it('sends the current token as the Bearer credential, not a cookie', async () => {
      fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
      await client().refreshToken('old-token')

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://www.protectthepod.com/api/auth/refresh')
      expect(init.method).toBe('POST')
      expect(init.headers.Authorization).toBe('Bearer old-token')
    })
  })
})
