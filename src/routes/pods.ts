import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { PtpClient } from '../ptp/client.js'
import { decryptToken } from '../crypto/tokenCrypto.js'

export interface PodRouteDeps {
  prisma: PrismaClient
  ptp: PtpClient
  tokenEncryptionKey: string
}

export function registerPodRoutes(app: FastifyInstance, deps: PodRouteDeps): void {
  // INTEGRATIONS.md §7.5 steps 1-2 — creates the round + one PodRoundTarget
  // per guild, resolving each target's broadcast channel from its
  // GuildSubscription. Does NOT post the Discord messages itself — that's
  // discord-bot's job (it holds the bot token, this service never talks to
  // Discord directly), using the `targets` this returns.
  app.post<{
    Body: { organizerDiscordId: string; setCode: string; threshold: number; guildIds: string[] }
  }>('/pods/start', async (request, reply) => {
    const { organizerDiscordId, setCode, threshold, guildIds } = request.body

    const subscriptions = await deps.prisma.guildSubscription.findMany({
      where: { guildId: { in: guildIds } },
    })
    // A guild could theoretically have unsubscribed between /start-pod's
    // eligibility check and this call — skip it rather than failing the
    // whole round over one stale target.
    const resolvedTargets = subscriptions.map((sub) => ({
      guildId: sub.guildId,
      channelId: sub.broadcastChannelId,
    }))

    const round = await deps.prisma.podRound.create({
      data: {
        organizerDiscordId,
        setCode,
        threshold,
        targets: {
          create: resolvedTargets.map((t) => ({ guildId: t.guildId, channelId: t.channelId })),
        },
      },
    })

    return reply.send({ podRoundId: round.id, targets: resolvedTargets })
  })

  // Records the Discord message ID discord-bot got back after posting the
  // RSVP embed into a target guild's channel — needed so a later signup can
  // fan an edit out to every target guild's message, not just the one the
  // click happened in (§7.5 step 3).
  app.post<{ Params: { id: string; guildId: string }; Body: { messageId: string } }>(
    '/pods/:id/targets/:guildId/message',
    async (request, reply) => {
      const { id: podRoundId, guildId } = request.params
      const { messageId } = request.body

      const target = await deps.prisma.podRoundTarget.findUnique({
        where: { podRoundId_guildId: { podRoundId, guildId } },
      })
      if (!target) {
        return reply.code(404).send({ error: 'Pod round target not found' })
      }

      await deps.prisma.podRoundTarget.update({
        where: { podRoundId_guildId: { podRoundId, guildId } },
        data: { messageId },
      })

      return reply.send({ ok: true })
    }
  )

  // INTEGRATIONS.md §7.3 key invariant — dedupe by discordId across the
  // WHOLE round (not per guild), then §7.5 step 4 — on threshold, call PTP.
  app.post<{
    Params: { id: string }
    Body: { discordId: string; username: string; sourceGuildId: string }
  }>('/pods/:id/signup', async (request, reply) => {
    const { id: podRoundId } = request.params
    const { discordId, username, sourceGuildId } = request.body

    const round = await deps.prisma.podRound.findUnique({
      where: { id: podRoundId },
      include: { organizer: true },
    })
    if (!round) {
      return reply.code(404).send({ error: 'Pod round not found' })
    }

    await deps.prisma.podRoundSignup.upsert({
      where: { podRoundId_discordId: { podRoundId, discordId } },
      create: { podRoundId, discordId, usernameSnapshot: username, sourceGuildId, status: 'IN' },
      update: { status: 'IN' },
    })

    const count = await deps.prisma.podRoundSignup.count({
      where: { podRoundId, status: 'IN' },
    })

    const thresholdReached = count >= round.threshold
    let podCreated = false
    let shareUrl: string | undefined

    if (thresholdReached && round.status === 'COLLECTING') {
      try {
        const token = decryptToken(round.organizer.encryptedToken, deps.tokenEncryptionKey)
        const result = await deps.ptp.createPod(token, {
          setCode: round.setCode,
          maxPlayers: round.threshold,
        })
        await deps.prisma.podRound.update({
          where: { id: podRoundId },
          data: { status: 'POD_CREATED', ptpPodShareId: result.shareId },
        })
        podCreated = true
        shareUrl = result.shareUrl
      } catch (err) {
        // Pod creation failed (e.g. expired/revoked token) even though
        // we've hit the player threshold — mark it so this doesn't
        // silently retry on every subsequent signup. Needs an operator-
        // facing alert path, not yet built.
        app.log.error({ err, podRoundId }, 'PTP pod creation failed after threshold reached')
        await deps.prisma.podRound.update({
          where: { id: podRoundId },
          data: { status: 'THRESHOLD_REACHED' },
        })
      }
    }

    // Every target for the round, not just sourceGuildId's — discord-bot
    // needs the full list to fan the updated count out to every guild's
    // message (§7.5 step 3). Only targets with a recorded messageId are
    // actually editable; discord-bot filters those out itself.
    const targetRows = await deps.prisma.podRoundTarget.findMany({ where: { podRoundId } })
    const targets = targetRows.map((t) => ({
      guildId: t.guildId,
      channelId: t.channelId,
      messageId: t.messageId,
    }))

    return reply.send({
      count,
      threshold: round.threshold,
      setCode: round.setCode,
      thresholdReached,
      podCreated,
      shareUrl,
      targets,
    })
  })

  // INTEGRATIONS.md §7.5 step 5.
  app.post<{ Params: { id: string }; Body: { requestedBy: string } }>(
    '/pods/:id/cancel',
    async (request, reply) => {
      const { id: podRoundId } = request.params
      const { requestedBy } = request.body

      const round = await deps.prisma.podRound.findUnique({ where: { id: podRoundId } })
      if (!round) {
        return reply.code(404).send({ error: 'Pod round not found' })
      }
      if (round.organizerDiscordId !== requestedBy) {
        return reply.code(403).send({ error: 'Only the organizer who started this round can cancel it' })
      }

      await deps.prisma.podRound.update({
        where: { id: podRoundId },
        data: { status: 'CANCELLED' },
      })

      return reply.send({ ok: true })
    }
  )
}
