import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { PtpClient } from '../ptp/client.js'
import { encryptToken } from '../crypto/tokenCrypto.js'
import { registerPodRoutes } from './pods.js'

const TOKEN_KEY = '00'.repeat(32) // 32-byte hex key, fine for tests

function buildApp(overrides: { prisma?: Record<string, unknown>; ptp?: Partial<PtpClient> } = {}) {
  const app = Fastify()
  const prisma = {
    podRound: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    podRoundSignup: { upsert: vi.fn(), count: vi.fn() },
    ...overrides.prisma,
  } as unknown as PrismaClient
  const ptp = {
    createPod: vi.fn(),
    ...overrides.ptp,
  } as unknown as PtpClient

  registerPodRoutes(app, { prisma, ptp, tokenEncryptionKey: TOKEN_KEY })
  return { app, prisma, ptp }
}

function fakeRound(overrides: Record<string, unknown> = {}) {
  return {
    id: 'round-1',
    organizerDiscordId: 'organizer-1',
    setCode: 'JTL',
    threshold: 8,
    status: 'COLLECTING',
    organizer: { discordId: 'organizer-1', encryptedToken: encryptToken('a-real-token', TOKEN_KEY) },
    ...overrides,
  }
}

describe('POST /pods/start', () => {
  it('creates a round with a PodRoundTarget per guild and returns its id', async () => {
    const { app, prisma } = buildApp({
      prisma: { podRound: { create: vi.fn().mockResolvedValue({ id: 'round-1' }) } },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/start',
      payload: { organizerDiscordId: 'organizer-1', setCode: 'JTL', threshold: 8, guildIds: ['g1', 'g2'] },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ podRoundId: 'round-1' })
    expect(prisma.podRound.create).toHaveBeenCalledWith({
      data: {
        organizerDiscordId: 'organizer-1',
        setCode: 'JTL',
        threshold: 8,
        targets: { create: [{ guildId: 'g1', channelId: '' }, { guildId: 'g2', channelId: '' }] },
      },
    })
  })

  it('handles an empty guildIds list without erroring', async () => {
    const { app } = buildApp({ prisma: { podRound: { create: vi.fn().mockResolvedValue({ id: 'round-1' }) } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/start',
      payload: { organizerDiscordId: 'organizer-1', setCode: 'JTL', threshold: 8, guildIds: [] },
    })

    expect(response.statusCode).toBe(200)
  })
})

describe('POST /pods/:id/signup', () => {
  it('returns 404 when the round does not exist', async () => {
    const { app } = buildApp({ prisma: { podRound: { findUnique: vi.fn().mockResolvedValue(null) } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/signup',
      payload: { discordId: 'player-1', username: 'PlayerOne', sourceGuildId: 'guild-1' },
    })

    expect(response.statusCode).toBe(404)
  })

  it('records the signup and reports the count without creating a pod when below threshold', async () => {
    const { app, prisma, ptp } = buildApp({
      prisma: {
        podRound: { findUnique: vi.fn().mockResolvedValue(fakeRound()) },
        podRoundSignup: { upsert: vi.fn(), count: vi.fn().mockResolvedValue(5) },
      },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/signup',
      payload: { discordId: 'player-1', username: 'PlayerOne', sourceGuildId: 'guild-1' },
    })

    expect(response.json()).toEqual({ count: 5, threshold: 8, thresholdReached: false, podCreated: false })
    expect(prisma.podRoundSignup.upsert).toHaveBeenCalledWith({
      where: { podRoundId_discordId: { podRoundId: 'round-1', discordId: 'player-1' } },
      create: { podRoundId: 'round-1', discordId: 'player-1', usernameSnapshot: 'PlayerOne', sourceGuildId: 'guild-1', status: 'IN' },
      update: { status: 'IN' },
    })
    expect(ptp.createPod).not.toHaveBeenCalled()
  })

  it('creates the PTP pod once the signup pushes the count to threshold', async () => {
    const round = fakeRound()
    const { app, prisma, ptp } = buildApp({
      prisma: {
        podRound: { findUnique: vi.fn().mockResolvedValue(round), update: vi.fn() },
        podRoundSignup: { upsert: vi.fn(), count: vi.fn().mockResolvedValue(8) },
      },
      ptp: {
        createPod: vi.fn().mockResolvedValue({
          id: 'ptp-pod-1',
          shareId: 'share-1',
          shareUrl: 'https://www.protectthepod.com/draft/share-1',
          createdAt: '2026-01-01T00:00:00Z',
        }),
      },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/signup',
      payload: { discordId: 'player-8', username: 'PlayerEight', sourceGuildId: 'guild-1' },
    })

    expect(ptp.createPod).toHaveBeenCalledWith('a-real-token', { setCode: 'JTL', maxPlayers: 8 })
    expect(prisma.podRound.update).toHaveBeenCalledWith({
      where: { id: 'round-1' },
      data: { status: 'POD_CREATED', ptpPodShareId: 'share-1' },
    })
    expect(response.json()).toEqual({
      count: 8,
      threshold: 8,
      thresholdReached: true,
      podCreated: true,
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
    })
  })

  it('marks the round THRESHOLD_REACHED (not an error response) when PTP pod creation fails after threshold is hit', async () => {
    const round = fakeRound()
    const { app, prisma, ptp } = buildApp({
      prisma: {
        podRound: { findUnique: vi.fn().mockResolvedValue(round), update: vi.fn() },
        podRoundSignup: { upsert: vi.fn(), count: vi.fn().mockResolvedValue(8) },
      },
      ptp: { createPod: vi.fn().mockRejectedValue(new Error('PTP pod creation failed: 401')) },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/signup',
      payload: { discordId: 'player-8', username: 'PlayerEight', sourceGuildId: 'guild-1' },
    })

    // The signup itself still succeeds from the player's point of view —
    // only the pod-creation side effect failed. §7.5 step 4's design note:
    // this needs an operator-facing alert, not yet built (see source TODO).
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ thresholdReached: true, podCreated: false })
    expect(response.json().shareUrl).toBeUndefined()
    expect(prisma.podRound.update).toHaveBeenCalledWith({
      where: { id: 'round-1' },
      data: { status: 'THRESHOLD_REACHED' },
    })
  })

  it('does not re-trigger PTP pod creation for a round that already reached POD_CREATED', async () => {
    // e.g. a player leaving and re-joining after the pod already exists.
    const round = fakeRound({ status: 'POD_CREATED' })
    const { prisma, ptp, app } = buildApp({
      prisma: {
        podRound: { findUnique: vi.fn().mockResolvedValue(round), update: vi.fn() },
        podRoundSignup: { upsert: vi.fn(), count: vi.fn().mockResolvedValue(8) },
      },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/signup',
      payload: { discordId: 'player-9', username: 'PlayerNine', sourceGuildId: 'guild-1' },
    })

    expect(ptp.createPod).not.toHaveBeenCalled()
    expect(prisma.podRound.update).not.toHaveBeenCalled()
    expect(response.json()).toMatchObject({ thresholdReached: true, podCreated: false })
  })
})

describe('POST /pods/:id/cancel', () => {
  it('returns 404 when the round does not exist', async () => {
    const { app } = buildApp({ prisma: { podRound: { findUnique: vi.fn().mockResolvedValue(null) } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/cancel',
      payload: { requestedBy: 'organizer-1' },
    })

    expect(response.statusCode).toBe(404)
  })

  it('returns 403 when the requester is not the round\'s organizer', async () => {
    const { app, prisma } = buildApp({
      prisma: { podRound: { findUnique: vi.fn().mockResolvedValue(fakeRound()), update: vi.fn() } },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/cancel',
      payload: { requestedBy: 'someone-else' },
    })

    expect(response.statusCode).toBe(403)
    expect(prisma.podRound.update).not.toHaveBeenCalled()
  })

  it('cancels the round when the requester is the organizer', async () => {
    const { app, prisma } = buildApp({
      prisma: { podRound: { findUnique: vi.fn().mockResolvedValue(fakeRound()), update: vi.fn() } },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/cancel',
      payload: { requestedBy: 'organizer-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(prisma.podRound.update).toHaveBeenCalledWith({
      where: { id: 'round-1' },
      data: { status: 'CANCELLED' },
    })
  })
})
