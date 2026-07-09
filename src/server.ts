import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import { requireBotApiKey } from './auth.js'
import { PtpClient } from './ptp/client.js'
import { zodValidatorCompiler } from './validation.js'
import { registerOrganizerRoutes } from './routes/organizers.js'
import { registerGuildRoutes } from './routes/guilds.js'
import { registerPodRoutes } from './routes/pods.js'

const botApiKey = requireEnv('BOT_API_KEY')
const tokenEncryptionKey = requireEnv('TOKEN_ENCRYPTION_KEY')
const ptpBaseUrl = requireEnv('PTP_BASE_URL')

const prisma = new PrismaClient()
const ptp = new PtpClient({ baseUrl: ptpBaseUrl })

const app = Fastify()
app.setValidatorCompiler(zodValidatorCompiler)

// /healthz stays outside this encapsulated scope so infra health probes
// don't need the bot's API key — Fastify's addHook only applies within the
// plugin scope it's registered in, not globally, so this separation is
// what actually keeps the route unauthenticated (a route-level preHandler
// override does not skip a hook added at a parent scope).
app.get('/healthz', async () => ({ ok: true }))

await app.register(async (instance) => {
  instance.addHook('preHandler', requireBotApiKey(botApiKey))

  registerOrganizerRoutes(instance, { prisma, ptp, tokenEncryptionKey })
  registerGuildRoutes(instance, { prisma })
  registerPodRoutes(instance, { prisma, ptp, tokenEncryptionKey })
})

const port = Number(process.env.PORT ?? 3001)
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`backend listening on :${port}`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })

process.on('SIGTERM', async () => {
  await prisma.$disconnect()
  process.exit(0)
})

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}
