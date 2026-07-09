import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { zodValidatorCompiler } from '../validation.js'
import type { PtpClient } from '../ptp/client.js'
import { encryptToken } from '../crypto/tokenCrypto.js'
import { createFakePrismaClient, type FakePrismaOverrides } from '../testUtils/fakePrismaClient.js'
import { createFakePtpClient } from '../testUtils/fakePtpClient.js'
import { registerPodRoutes } from './pods.js'

const TOKEN_KEY = '00'.repeat(32) // 32-byte hex key, fine for tests

function buildApp(overrides: { prisma?: FakePrismaOverrides; ptp?: Partial<PtpClient> } = {}) {
  const app = Fastify()
  app.setValidatorCompiler(zodValidatorCompiler)
  const prisma = createFakePrismaClient({
    podRoundTarget: { findMany: vi.fn().mockResolvedValue([]) },
    guildSubscription: { findMany: vi.fn().mockResolvedValue([]) },
    ...overrides.prisma,
  })
  const ptp = createFakePtpClient(overrides.ptp)

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
  function subscriptions() {
    return [
      { guildId: 'g1', broadcastChannelId: 'channel-1' },
      { guildId: 'g2', broadcastChannelId: 'channel-2' },
    ]
  }

  it('resolves each target guild\'s broadcast channel and returns it alongside the round id', async () => {
    const { app, prisma } = buildApp({
      prisma: {
        podRound: { create: vi.fn().mockResolvedValue({ id: 'round-1' }) },
        guildSubscription: { findMany: vi.fn().mockResolvedValue(subscriptions()) },
      },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/start',
      payload: { organizerDiscordId: 'organizer-1', setCode: 'JTL', threshold: 8, guildIds: ['g1', 'g2'] },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      podRoundId: 'round-1',
      targets: [{ guildId: 'g1', channelId: 'channel-1' }, { guildId: 'g2', channelId: 'channel-2' }],
    })
    expect(prisma.podRound.create).toHaveBeenCalledWith({
      data: {
        organizerDiscordId: 'organizer-1',
        setCode: 'JTL',
        threshold: 8,
        targets: {
          create: [{ guildId: 'g1', channelId: 'channel-1' }, { guildId: 'g2', channelId: 'channel-2' }],
        },
      },
    })
  })

  it('silently drops a guildId whose subscription no longer exists rather than failing the whole round', async () => {
    // e.g. a guild unsubscribed between /start-pod's eligibility check and
    // this call — a stale target shouldn't block starting the round.
    const { app } = buildApp({
      prisma: {
        podRound: { create: vi.fn().mockResolvedValue({ id: 'round-1' }) },
        guildSubscription: { findMany: vi.fn().mockResolvedValue([subscriptions()[0]]) },
      },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/start',
      payload: { organizerDiscordId: 'organizer-1', setCode: 'JTL', threshold: 8, guildIds: ['g1', 'g2-gone'] },
    })

    expect(response.json().targets).toEqual([{ guildId: 'g1', channelId: 'channel-1' }])
  })

  it('handles an empty guildIds list without erroring', async () => {
    const { app } = buildApp({ prisma: { podRound: { create: vi.fn().mockResolvedValue({ id: 'round-1' }) } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/start',
      payload: { organizerDiscordId: 'organizer-1', setCode: 'JTL', threshold: 8, guildIds: [] },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().targets).toEqual([])
  })

  describe('request validation', () => {
    const validPayload = {
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: 8,
      guildIds: ['g1'],
    }

    it('rejects a missing required field with 400, before touching prisma', async () => {
      const { app, prisma } = buildApp()
      const { guildIds, ...withoutGuildIds } = validPayload
      void guildIds

      const response = await app.inject({ method: 'POST', url: '/pods/start', payload: withoutGuildIds })

      expect(response.statusCode).toBe(400)
      expect(prisma.podRound.create).not.toHaveBeenCalled()
    })

    it.each([5, 9, 0, -1])('rejects a threshold outside the 6-8 range (%i)', async (threshold) => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/pods/start',
        payload: { ...validPayload, threshold },
      })

      expect(response.statusCode).toBe(400)
    })

    it('rejects a non-integer threshold', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/pods/start',
        payload: { ...validPayload, threshold: 6.5 },
      })

      expect(response.statusCode).toBe(400)
    })

    it('rejects guildIds that is not an array of strings', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/pods/start',
        payload: { ...validPayload, guildIds: [123, 'g2'] },
      })

      expect(response.statusCode).toBe(400)
    })

    it('rejects an empty-string setCode', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/pods/start',
        payload: { ...validPayload, setCode: '' },
      })

      expect(response.statusCode).toBe(400)
    })
  })
})

describe('POST /pods/:id/targets/:guildId/message', () => {
  it('records the messageId on the matching target', async () => {
    const { app, prisma } = buildApp({
      prisma: {
        podRoundTarget: {
          findUnique: vi.fn().mockResolvedValue({ podRoundId: 'round-1', guildId: 'g1' }),
          update: vi.fn(),
        },
      },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/targets/g1/message',
      payload: { messageId: 'msg-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(prisma.podRoundTarget.update).toHaveBeenCalledWith({
      where: { podRoundId_guildId: { podRoundId: 'round-1', guildId: 'g1' } },
      data: { messageId: 'msg-1' },
    })
  })

  it('returns 404 when there is no target for that round/guild pair', async () => {
    const { app, prisma } = buildApp({
      prisma: { podRoundTarget: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() } },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/targets/unknown-guild/message',
      payload: { messageId: 'msg-1' },
    })

    expect(response.statusCode).toBe(404)
    expect(prisma.podRoundTarget.update).not.toHaveBeenCalled()
  })

  it('rejects an empty-string messageId with 400 rather than storing it', async () => {
    const { app, prisma } = buildApp({
      prisma: {
        podRoundTarget: { findUnique: vi.fn().mockResolvedValue({ podRoundId: 'round-1', guildId: 'g1' }), update: vi.fn() },
      },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/targets/g1/message',
      payload: { messageId: '' },
    })

    expect(response.statusCode).toBe(400)
    expect(prisma.podRoundTarget.update).not.toHaveBeenCalled()
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

    expect(response.json()).toEqual({
      count: 5,
      threshold: 8,
      setCode: 'JTL',
      thresholdReached: false,
      podCreated: false,
      targets: [],
    })
    expect(prisma.podRoundSignup.upsert).toHaveBeenCalledWith({
      where: { podRoundId_discordId: { podRoundId: 'round-1', discordId: 'player-1' } },
      create: { podRoundId: 'round-1', discordId: 'player-1', usernameSnapshot: 'PlayerOne', sourceGuildId: 'guild-1', status: 'IN' },
      update: { status: 'IN' },
    })
    expect(ptp.createPod).not.toHaveBeenCalled()
  })

  it('creates the PTP pod once the signup pushes the count to threshold, and returns every target for cross-guild sync', async () => {
    const round = fakeRound()
    const targetRows = [
      { guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1' },
      { guildId: 'g2', channelId: 'channel-2', messageId: null },
    ]
    const { app, prisma, ptp } = buildApp({
      prisma: {
        podRound: { findUnique: vi.fn().mockResolvedValue(round), update: vi.fn() },
        podRoundSignup: { upsert: vi.fn(), count: vi.fn().mockResolvedValue(8) },
        podRoundTarget: { findMany: vi.fn().mockResolvedValue(targetRows) },
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
      setCode: 'JTL',
      thresholdReached: true,
      podCreated: true,
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      targets: targetRows,
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

  it('rejects a signup body missing a required field with 400, before reading the round', async () => {
    const { app, prisma } = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/signup',
      payload: { discordId: 'player-1', username: 'PlayerOne' }, // no sourceGuildId
    })

    expect(response.statusCode).toBe(400)
    expect(prisma.podRound.findUnique).not.toHaveBeenCalled()
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

  it('rejects a missing requestedBy with 400, before reading the round', async () => {
    const { app, prisma } = buildApp()

    const response = await app.inject({ method: 'POST', url: '/pods/round-1/cancel', payload: {} })

    expect(response.statusCode).toBe(400)
    expect(prisma.podRound.findUnique).not.toHaveBeenCalled()
  })
})
