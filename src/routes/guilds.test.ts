import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { zodValidatorCompiler } from '../validation.js'
import { createFakePrismaClient, type FakePrismaOverrides } from '../testUtils/fakePrismaClient.js'
import { registerGuildRoutes } from './guilds.js'

function buildApp(overrides: { prisma?: FakePrismaOverrides } = {}) {
  const app = Fastify()
  app.setValidatorCompiler(zodValidatorCompiler)
  const prisma = createFakePrismaClient(overrides.prisma)

  registerGuildRoutes(app, { prisma })
  return { app, prisma }
}

describe('POST /guilds/subscribe', () => {
  it('upserts the subscription keyed by guildId', async () => {
    const { app, prisma } = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/subscribe',
      payload: { guildId: 'guild-1', channelId: 'channel-1', installedBy: 'admin-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(prisma.guildSubscription.upsert).toHaveBeenCalledWith({
      where: { guildId: 'guild-1' },
      create: { guildId: 'guild-1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
      update: { broadcastChannelId: 'channel-1' },
    })
  })

  it('re-subscribing (already-known guildId) only updates the channel, not installedBy', async () => {
    // §7.2: installedByDiscordId should be set once at creation and not
    // silently change to whoever last ran /subscribe-guild. This is what
    // actually enforces that — Prisma's upsert applies `update` verbatim
    // on conflict, so `update` must not include installedByDiscordId.
    const { app, prisma } = buildApp()

    await app.inject({
      method: 'POST',
      url: '/guilds/subscribe',
      payload: { guildId: 'guild-1', channelId: 'channel-2', installedBy: 'someone-else' },
    })

    const call = (prisma.guildSubscription.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.update).not.toHaveProperty('installedByDiscordId')
  })

  it('rejects a body missing a required field with 400, before touching prisma', async () => {
    const { app, prisma } = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/subscribe',
      payload: { guildId: 'guild-1', channelId: 'channel-1' }, // no installedBy
    })

    expect(response.statusCode).toBe(400)
    expect(prisma.guildSubscription.upsert).not.toHaveBeenCalled()
  })
})

describe('POST /guilds/allow-organizer', () => {
  it('upserts the allowlist entry keyed by guildId+organizerDiscordId', async () => {
    const { app, prisma } = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/allow-organizer',
      payload: { guildId: 'guild-1', organizerDiscordId: 'organizer-1', approvedBy: 'admin-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(prisma.guildOrganizerAllowlist.upsert).toHaveBeenCalledWith({
      where: { guildId_organizerDiscordId: { guildId: 'guild-1', organizerDiscordId: 'organizer-1' } },
      create: { guildId: 'guild-1', organizerDiscordId: 'organizer-1', approvedBy: 'admin-1' },
      update: { approvedBy: 'admin-1' },
    })
  })

  it('re-approving updates who approved it most recently', async () => {
    const { app, prisma } = buildApp()

    await app.inject({
      method: 'POST',
      url: '/guilds/allow-organizer',
      payload: { guildId: 'guild-1', organizerDiscordId: 'organizer-1', approvedBy: 'admin-2' },
    })

    const call = (prisma.guildOrganizerAllowlist.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.update).toEqual({ approvedBy: 'admin-2' })
  })

  it('rejects a non-string organizerDiscordId with 400', async () => {
    const { app, prisma } = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/allow-organizer',
      payload: { guildId: 'guild-1', organizerDiscordId: 12345, approvedBy: 'admin-1' },
    })

    expect(response.statusCode).toBe(400)
    expect(prisma.guildOrganizerAllowlist.upsert).not.toHaveBeenCalled()
  })
})
