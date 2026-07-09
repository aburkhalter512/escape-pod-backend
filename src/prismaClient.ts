import type { PrismaClient } from '@prisma/client'

// The contract routes/jobs actually depend on — derived via Pick from
// Prisma's own generated types, not hand-duplicated, so argument/return
// shapes stay perfectly in sync with prisma/schema.prisma with zero drift
// risk. Narrower than PrismaClient on purpose: a hand-written test stub
// (testUtils/fakePrismaClient.ts) can fully satisfy this interface with no
// `as unknown as` cast, because it only has to implement the dozen methods
// our code actually calls instead of Prisma's entire generated surface.
export interface AppPrismaClient {
  organizer: Pick<PrismaClient['organizer'], 'findMany' | 'update' | 'upsert'>
  guildSubscription: Pick<PrismaClient['guildSubscription'], 'findMany' | 'upsert'>
  guildOrganizerAllowlist: Pick<PrismaClient['guildOrganizerAllowlist'], 'upsert'>
  podRound: Pick<PrismaClient['podRound'], 'create' | 'findUnique' | 'update'>
  podRoundTarget: Pick<PrismaClient['podRoundTarget'], 'findMany' | 'findUnique' | 'update'>
  podRoundSignup: Pick<PrismaClient['podRoundSignup'], 'count' | 'upsert'>
}
