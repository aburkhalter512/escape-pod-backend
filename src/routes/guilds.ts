import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { z } from 'zod'

export interface GuildRouteDeps {
  prisma: PrismaClient
}

const subscribeGuildBodySchema = z.object({
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  installedBy: z.string().min(1),
})
type SubscribeGuildBody = z.infer<typeof subscribeGuildBodySchema>

const allowOrganizerBodySchema = z.object({
  guildId: z.string().min(1),
  organizerDiscordId: z.string().min(1),
  approvedBy: z.string().min(1),
})
type AllowOrganizerBody = z.infer<typeof allowOrganizerBodySchema>

export function registerGuildRoutes(app: FastifyInstance, deps: GuildRouteDeps): void {
  // INTEGRATIONS.md §7.2/§7.4 — a guild's own admin opts their server in,
  // independent of any organizer. Defaults to ALLOWLIST per §7.2's safer-
  // default reasoning.
  app.post<{ Body: SubscribeGuildBody }>(
    '/guilds/subscribe',
    { schema: { body: subscribeGuildBodySchema } },
    async (request, reply) => {
      const { guildId, channelId, installedBy } = request.body

      await deps.prisma.guildSubscription.upsert({
        where: { guildId },
        create: {
          guildId,
          broadcastChannelId: channelId,
          installedByDiscordId: installedBy,
        },
        update: {
          broadcastChannelId: channelId,
        },
      })

      return reply.send({ ok: true })
    }
  )

  // INTEGRATIONS.md §7.2/§7.4 — guild admin approves a specific organizer.
  // Only consulted when the guild's policy is ALLOWLIST.
  app.post<{ Body: AllowOrganizerBody }>(
    '/guilds/allow-organizer',
    { schema: { body: allowOrganizerBodySchema } },
    async (request, reply) => {
      const { guildId, organizerDiscordId, approvedBy } = request.body

      await deps.prisma.guildOrganizerAllowlist.upsert({
        where: { guildId_organizerDiscordId: { guildId, organizerDiscordId } },
        create: { guildId, organizerDiscordId, approvedBy },
        update: { approvedBy },
      })

      return reply.send({ ok: true })
    }
  )
}
