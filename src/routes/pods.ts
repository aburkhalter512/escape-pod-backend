import type { FastifyInstance } from 'fastify'
import type { AppPrismaClient } from '../prismaClient.js'
import { z } from 'zod'
import type { PtpClient } from '../ptp/client.js'
import { decryptToken } from '../crypto/tokenCrypto.js'

export interface PodRouteDeps {
  prisma: AppPrismaClient
  ptp: PtpClient
  tokenEncryptionKey: string
}

const startPodBodySchema = z.object({
  organizerDiscordId: z.string().min(1),
  setCode: z.string().min(1),
  // Matches the /start-pod command's own min/max (INTEGRATIONS.md §7.4) —
  // enforced again here since the backend can't trust discord-bot is the
  // only thing that will ever call this API.
  threshold: z.number().int().min(6).max(8),
  guildIds: z.array(z.string().min(1)),
})
type StartPodBody = z.infer<typeof startPodBodySchema>

const targetMessageParamsSchema = z.object({
  id: z.string().min(1),
  guildId: z.string().min(1),
})
type TargetMessageParams = z.infer<typeof targetMessageParamsSchema>

const targetMessageBodySchema = z.object({
  messageId: z.string().min(1),
})
type TargetMessageBody = z.infer<typeof targetMessageBodySchema>

const signupParamsSchema = z.object({ id: z.string().min(1) })
type SignupParams = z.infer<typeof signupParamsSchema>

const signupBodySchema = z.object({
  discordId: z.string().min(1),
  username: z.string().min(1),
  sourceGuildId: z.string().min(1),
  action: z.enum(['in', 'leave']),
})
type SignupBody = z.infer<typeof signupBodySchema>

const cancelParamsSchema = z.object({ id: z.string().min(1) })
type CancelParams = z.infer<typeof cancelParamsSchema>

const cancelBodySchema = z.object({ requestedBy: z.string().min(1) })
type CancelBody = z.infer<typeof cancelBodySchema>

export function registerPodRoutes(app: FastifyInstance, deps: PodRouteDeps): void {
  // INTEGRATIONS.md §7.5 steps 1-2 — creates the round + one PodRoundTarget
  // per guild, resolving each target's broadcast channel from its
  // GuildSubscription. Does NOT post the Discord messages itself — that's
  // discord-bot's job (it holds the bot token, this service never talks to
  // Discord directly), using the `targets` this returns.
  app.post<{ Body: StartPodBody }>(
    '/pods/start',
    { schema: { body: startPodBodySchema } },
    async (request, reply) => {
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
    }
  )

  // Records the Discord message ID discord-bot got back after posting the
  // RSVP embed into a target guild's channel — needed so a later signup can
  // fan an edit out to every target guild's message, not just the one the
  // click happened in (§7.5 step 3).
  app.post<{ Params: TargetMessageParams; Body: TargetMessageBody }>(
    '/pods/:id/targets/:guildId/message',
    { schema: { params: targetMessageParamsSchema, body: targetMessageBodySchema } },
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
  app.post<{ Params: SignupParams; Body: SignupBody }>(
    '/pods/:id/signup',
    { schema: { params: signupParamsSchema, body: signupBodySchema } },
    async (request, reply) => {
      const { id: podRoundId } = request.params
      const { discordId, username, sourceGuildId, action } = request.body
      const status = action === 'leave' ? 'LEFT' : 'IN'

      const round = await deps.prisma.podRound.findUnique({
        where: { id: podRoundId },
        include: { organizer: true },
      })
      if (!round) {
        return reply.code(404).send({ error: 'Pod round not found' })
      }

      await deps.prisma.podRoundSignup.upsert({
        where: { podRoundId_discordId: { podRoundId, discordId } },
        create: { podRoundId, discordId, usernameSnapshot: username, sourceGuildId, status },
        update: { status },
      })

      const count = await deps.prisma.podRoundSignup.count({
        where: { podRoundId, status: 'IN' },
      })

      const thresholdReached = count >= round.threshold
      let podCreated = false
      let shareUrl: string | undefined

      if (thresholdReached && round.status === 'COLLECTING') {
        // §7.5 step 4 / tasks/001: a plain read-then-write here is racy —
        // two signups landing close together could both observe
        // status: 'COLLECTING' and both call ptp.createPod. Postgres
        // serializes conditional UPDATEs, so this WHERE-guarded
        // updateMany atomically claims the transition for exactly one
        // concurrent caller; everyone else sees count: 0 and skips PTP
        // entirely. The claim itself lands on THRESHOLD_REACHED — the
        // same status the failure path below already used — so a claim
        // that's never followed by a successful create still leaves the
        // round in a correct, non-retrying state.
        const claim = await deps.prisma.podRound.updateMany({
          where: { id: podRoundId, status: 'COLLECTING' },
          data: { status: 'THRESHOLD_REACHED' },
        })

        if (claim.count === 1) {
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
            // we've hit the player threshold — the claim above already
            // recorded THRESHOLD_REACHED, so this doesn't silently retry
            // on every subsequent signup. Needs an operator-facing alert
            // path, not yet built.
            app.log.error({ err, podRoundId }, 'PTP pod creation failed after threshold reached')
          }
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
    }
  )

  // INTEGRATIONS.md §7.5 step 5.
  app.post<{ Params: CancelParams; Body: CancelBody }>(
    '/pods/:id/cancel',
    { schema: { params: cancelParamsSchema, body: cancelBodySchema } },
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
