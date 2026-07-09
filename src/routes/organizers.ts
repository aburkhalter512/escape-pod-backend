import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import type { PtpClient } from '../ptp/client.js'
import { encryptToken } from '../crypto/tokenCrypto.js'
import { decodeJwtPayloadUnverified } from '../util/jwt.js'

export interface OrganizerRouteDeps {
  prisma: PrismaClient
  ptp: PtpClient
  tokenEncryptionKey: string
}

const linkOrganizerBodySchema = z.object({
  discordId: z.string().min(1),
  token: z.string().min(1),
})
type LinkOrganizerBody = z.infer<typeof linkOrganizerBodySchema>

const eligibleGuildsParamsSchema = z.object({
  discordId: z.string().min(1),
})
type EligibleGuildsParams = z.infer<typeof eligibleGuildsParamsSchema>

export function registerOrganizerRoutes(app: FastifyInstance, deps: OrganizerRouteDeps): void {
  // INTEGRATIONS.md §8.2 step 3(d) + step 4 — the live check + storage half
  // of account linking. Structural + anti-mistake checks (a)-(c) already
  // happened bot-side before this was called.
  app.post<{ Body: LinkOrganizerBody }>(
    '/organizers/link',
    { schema: { body: linkOrganizerBodySchema } },
    async (request, reply) => {
      const { discordId, token } = request.body

      const isValid = await deps.ptp.validateToken(token)
      if (!isValid) {
        return reply.code(422).send({ error: 'PTP rejected this token' })
      }

      const payload = decodeJwtPayloadUnverified(token)
      if (!payload) {
        return reply.code(422).send({ error: 'Could not read token payload' })
      }

      await deps.prisma.organizer.upsert({
        where: { discordId },
        create: {
          discordId,
          username: payload.username,
          encryptedToken: encryptToken(token, deps.tokenEncryptionKey),
          expiresAt: new Date(payload.exp * 1000),
        },
        update: {
          username: payload.username,
          encryptedToken: encryptToken(token, deps.tokenEncryptionKey),
          expiresAt: new Date(payload.exp * 1000),
        },
      })

      return reply.send({ username: payload.username })
    }
  )

  // INTEGRATIONS.md §7.4/§7.5 step 1 — guilds this organizer may fan a
  // round out to: OPEN-policy guilds, plus guilds where they're allow-listed.
  app.get<{ Params: EligibleGuildsParams }>(
    '/organizers/:discordId/eligible-guilds',
    { schema: { params: eligibleGuildsParamsSchema } },
    async (request) => {
      const { discordId } = request.params

      const guilds = await deps.prisma.guildSubscription.findMany({
        where: {
          OR: [
            { postingPolicy: 'OPEN' },
            { allowlist: { some: { organizerDiscordId: discordId } } },
          ],
        },
      })

      // TODO: GuildSubscription doesn't store a human-readable guild name —
      // the backend never talks to Discord's API directly (only discord-bot
      // holds the bot token). Using guildId as a placeholder label until
      // that's threaded through /guilds/subscribe.
      return guilds.map((guild) => ({ guildId: guild.guildId, name: guild.guildId }))
    }
  )
}
