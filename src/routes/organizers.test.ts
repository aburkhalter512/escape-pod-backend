import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { zodValidatorCompiler } from '../validation.js'
import type { PrismaClient } from '@prisma/client'
import type { PtpClient } from '../ptp/client.js'
import { registerOrganizerRoutes } from './organizers.js'

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.sig`
}

const FUTURE_EXP = () => Math.floor(Date.now() / 1000) + 3600

function buildApp(overrides: { prisma?: Record<string, unknown>; ptp?: Partial<PtpClient> } = {}) {
  const app = Fastify()
  app.setValidatorCompiler(zodValidatorCompiler)
  const prisma = {
    organizer: { upsert: vi.fn() },
    guildSubscription: { findMany: vi.fn() },
    ...overrides.prisma,
  } as unknown as PrismaClient
  const ptp = {
    validateToken: vi.fn().mockResolvedValue(true),
    ...overrides.ptp,
  } as unknown as PtpClient

  // Must be a real 32-byte hex string — encryptToken calls createCipheriv
  // synchronously, so an invalid key throws and the route 500s.
  registerOrganizerRoutes(app, { prisma, ptp, tokenEncryptionKey: '00'.repeat(32) })
  return { app, prisma, ptp }
}

describe('POST /organizers/link', () => {
  it('validates the token against PTP, then upserts the organizer and returns the username', async () => {
    const token = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: FUTURE_EXP() })
    const { app, prisma, ptp } = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/organizers/link',
      payload: { discordId: 'user-1', token },
    })

    expect(ptp.validateToken).toHaveBeenCalledWith(token)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ username: 'PlayerOne' })

    expect(prisma.organizer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { discordId: 'user-1' },
        create: expect.objectContaining({ discordId: 'user-1', username: 'PlayerOne' }),
        update: expect.objectContaining({ username: 'PlayerOne' }),
      })
    )
  })

  it('computes expiresAt from the token exp claim (seconds -> Date)', async () => {
    const exp = FUTURE_EXP()
    const token = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp })
    const { app, prisma } = buildApp()

    await app.inject({ method: 'POST', url: '/organizers/link', payload: { discordId: 'user-1', token } })

    const call = (prisma.organizer.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.create.expiresAt).toEqual(new Date(exp * 1000))
  })

  it('rejects with 422 when PTP does not accept the token, without storing anything', async () => {
    const token = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: FUTURE_EXP() })
    const { app, prisma, ptp } = buildApp({ ptp: { validateToken: vi.fn().mockResolvedValue(false) } })

    const response = await app.inject({
      method: 'POST',
      url: '/organizers/link',
      payload: { discordId: 'user-1', token },
    })

    expect(response.statusCode).toBe(422)
    expect(prisma.organizer.upsert).not.toHaveBeenCalled()
    void ptp
  })

  it('rejects with 422 when the token cannot be decoded, even if PTP would have accepted it', async () => {
    const { app, prisma } = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/organizers/link',
      payload: { discordId: 'user-1', token: 'not-a-real-jwt' },
    })

    expect(response.statusCode).toBe(422)
    expect(prisma.organizer.upsert).not.toHaveBeenCalled()
  })

  it('rejects a body missing the token field with 400, before calling PTP', async () => {
    const { app, ptp } = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/organizers/link',
      payload: { discordId: 'user-1' },
    })

    expect(response.statusCode).toBe(400)
    expect(ptp.validateToken).not.toHaveBeenCalled()
  })

  it('rejects an empty-string discordId with 400', async () => {
    const { app, ptp } = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/organizers/link',
      payload: { discordId: '', token: 'some-token' },
    })

    expect(response.statusCode).toBe(400)
    expect(ptp.validateToken).not.toHaveBeenCalled()
  })
})

describe('GET /organizers/:discordId/eligible-guilds', () => {
  it('queries for OPEN-policy guilds plus guilds where the organizer is allow-listed', async () => {
    const { app, prisma } = buildApp({
      prisma: { guildSubscription: { findMany: vi.fn().mockResolvedValue([]) } },
    })

    await app.inject({ method: 'GET', url: '/organizers/user-1/eligible-guilds' })

    expect(prisma.guildSubscription.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ postingPolicy: 'OPEN' }, { allowlist: { some: { organizerDiscordId: 'user-1' } } }],
      },
    })
  })

  it('maps results to {guildId, name} (name is a guildId placeholder — see TODO in source)', async () => {
    const { app } = buildApp({
      prisma: {
        guildSubscription: {
          findMany: vi.fn().mockResolvedValue([{ guildId: 'g1' }, { guildId: 'g2' }]),
        },
      },
    })

    const response = await app.inject({ method: 'GET', url: '/organizers/user-1/eligible-guilds' })

    expect(response.json()).toEqual([
      { guildId: 'g1', name: 'g1' },
      { guildId: 'g2', name: 'g2' },
    ])
  })

  it('returns an empty array when the organizer has no eligible guilds', async () => {
    const { app } = buildApp({ prisma: { guildSubscription: { findMany: vi.fn().mockResolvedValue([]) } } })

    const response = await app.inject({ method: 'GET', url: '/organizers/user-1/eligible-guilds' })

    expect(response.json()).toEqual([])
  })
})
