import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { PtpClient } from '../ptp/client.js'
import { encryptToken, decryptToken } from '../crypto/tokenCrypto.js'
import { refreshExpiringTokens } from './refreshTokens.js'

const TOKEN_KEY = '00'.repeat(32)

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.sig`
}

function fakeOrganizer(discordId: string, token: string) {
  return { discordId, username: 'PlayerOne', encryptedToken: encryptToken(token, TOKEN_KEY), expiresAt: new Date() }
}

describe('refreshExpiringTokens', () => {
  it('queries for organizers expiring within the refresh window, not all organizers', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    const prisma = { organizer: { findMany, update: vi.fn() } } as unknown as PrismaClient
    const ptp = { refreshToken: vi.fn() } as unknown as PtpClient

    await refreshExpiringTokens(prisma, ptp, TOKEN_KEY)

    expect(findMany).toHaveBeenCalledWith({ where: { expiresAt: { lt: expect.any(Date) } } })
    const cutoff = findMany.mock.calls[0][0].where.expiresAt.lt as Date
    const daysFromNow = (cutoff.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    expect(daysFromNow).toBeGreaterThan(4.9)
    expect(daysFromNow).toBeLessThan(5.1)
  })

  it('rotates the stored token and expiry for an organizer whose refresh succeeds', async () => {
    const oldToken = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: 1000 })
    const newExp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
    const newToken = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: newExp })
    const organizer = fakeOrganizer('user-1', oldToken)

    const update = vi.fn()
    const prisma = {
      organizer: { findMany: vi.fn().mockResolvedValue([organizer]), update },
    } as unknown as PrismaClient
    const ptp = { refreshToken: vi.fn().mockResolvedValue(newToken) } as unknown as PtpClient

    const result = await refreshExpiringTokens(prisma, ptp, TOKEN_KEY)

    expect(ptp.refreshToken).toHaveBeenCalledWith(oldToken)
    expect(update).toHaveBeenCalledWith({
      where: { discordId: 'user-1' },
      data: { encryptedToken: expect.any(String), expiresAt: new Date(newExp * 1000) },
    })
    const storedCiphertext = update.mock.calls[0][0].data.encryptedToken
    expect(decryptToken(storedCiphertext, TOKEN_KEY)).toBe(newToken)
    expect(result).toEqual({ refreshed: 1, failed: 0, checked: 1 })
  })

  it('leaves the organizer untouched and counts it as failed when PTP refuses to refresh', async () => {
    const oldToken = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: 1000 })
    const organizer = fakeOrganizer('user-1', oldToken)

    const update = vi.fn()
    const prisma = {
      organizer: { findMany: vi.fn().mockResolvedValue([organizer]), update },
    } as unknown as PrismaClient
    const ptp = { refreshToken: vi.fn().mockResolvedValue(null) } as unknown as PtpClient

    const result = await refreshExpiringTokens(prisma, ptp, TOKEN_KEY)

    expect(update).not.toHaveBeenCalled()
    expect(result).toEqual({ refreshed: 0, failed: 1, checked: 1 })
  })

  it('counts it as failed (not a thrown error) when PTP returns a token that fails to decode', async () => {
    const oldToken = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: 1000 })
    const organizer = fakeOrganizer('user-1', oldToken)

    const update = vi.fn()
    const prisma = {
      organizer: { findMany: vi.fn().mockResolvedValue([organizer]), update },
    } as unknown as PrismaClient
    const ptp = { refreshToken: vi.fn().mockResolvedValue('not-a-valid-jwt') } as unknown as PtpClient

    const result = await refreshExpiringTokens(prisma, ptp, TOKEN_KEY)

    expect(update).not.toHaveBeenCalled()
    expect(result).toEqual({ refreshed: 0, failed: 1, checked: 1 })
  })

  it('processes every expiring organizer independently and tallies mixed outcomes', async () => {
    const successToken = fakeJwt({ discord_id: 'user-1', username: 'Success', exp: 1000 })
    const failToken = fakeJwt({ discord_id: 'user-2', username: 'Fail', exp: 1000 })
    const refreshedToken = fakeJwt({
      discord_id: 'user-1',
      username: 'Success',
      exp: Math.floor(Date.now() / 1000) + 1000,
    })

    const organizers = [fakeOrganizer('user-1', successToken), fakeOrganizer('user-2', failToken)]
    const prisma = {
      organizer: { findMany: vi.fn().mockResolvedValue(organizers), update: vi.fn() },
    } as unknown as PrismaClient
    const ptp = {
      refreshToken: vi.fn(async (token: string) => (token === successToken ? refreshedToken : null)),
    } as unknown as PtpClient

    const result = await refreshExpiringTokens(prisma, ptp, TOKEN_KEY)

    expect(result).toEqual({ refreshed: 1, failed: 1, checked: 2 })
  })

  it('returns all-zero counts when nothing is expiring soon', async () => {
    const prisma = {
      organizer: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    } as unknown as PrismaClient
    const ptp = { refreshToken: vi.fn() } as unknown as PtpClient

    const result = await refreshExpiringTokens(prisma, ptp, TOKEN_KEY)

    expect(result).toEqual({ refreshed: 0, failed: 0, checked: 0 })
    expect(ptp.refreshToken).not.toHaveBeenCalled()
  })
})
