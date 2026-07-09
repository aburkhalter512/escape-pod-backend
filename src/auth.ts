import type { FastifyReply, FastifyRequest } from 'fastify'

// Only the discord-bot service should be able to call this API — shared
// secret, not PTP's auth at all (this backend is the thing that *holds*
// PTP credentials on organizers' behalf, per §8.5).
export function requireBotApiKey(expectedKey: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization
    if (header !== `Bearer ${expectedKey}`) {
      await reply.code(401).send({ error: 'Unauthorized' })
    }
  }
}
