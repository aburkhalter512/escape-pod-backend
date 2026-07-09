import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'

export interface GuildRouteDeps {
  prisma: PrismaClient
}

export function registerGuildRoutes(app: FastifyInstance, deps: GuildRouteDeps): void {
  // INTEGRATIONS.md §7.2/§7.4 — a guild's own admin opts their server in,
  // independent of any organizer. Defaults to ALLOWLIST per §7.2's safer-
  // default reasoning.
  app.post<{ Body: { guildId: string; channelId: string; installedBy: string } }>(
    '/guilds/subscribe',
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
  app.post<{ Body: { guildId: string; organizerDiscordId: string; approvedBy: string } }>(
    '/guilds/allow-organizer',
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
