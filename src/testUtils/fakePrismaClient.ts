import { vi } from 'vitest'
import type { AppPrismaClient } from '../prismaClient.js'

export interface FakePrismaOverrides {
  organizer?: Partial<AppPrismaClient['organizer']>
  guildSubscription?: Partial<AppPrismaClient['guildSubscription']>
  guildOrganizerAllowlist?: Partial<AppPrismaClient['guildOrganizerAllowlist']>
  podRound?: Partial<AppPrismaClient['podRound']>
  podRoundTarget?: Partial<AppPrismaClient['podRoundTarget']>
  podRoundSignup?: Partial<AppPrismaClient['podRoundSignup']>
}

// Fully satisfies AppPrismaClient (every delegate/method it declares gets a
// default vi.fn() stub), so callers never need `as unknown as PrismaClient`.
// Pass overrides for the specific delegate methods a given test cares
// about; everything else quietly resolves to undefined if called, same as
// before, just without the cast.
export function createFakePrismaClient(overrides: FakePrismaOverrides = {}): AppPrismaClient {
  return {
    organizer: { findMany: vi.fn(), update: vi.fn(), upsert: vi.fn(), ...overrides.organizer },
    guildSubscription: { findMany: vi.fn(), upsert: vi.fn(), ...overrides.guildSubscription },
    guildOrganizerAllowlist: { upsert: vi.fn(), ...overrides.guildOrganizerAllowlist },
    podRound: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), ...overrides.podRound },
    podRoundTarget: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      ...overrides.podRoundTarget,
    },
    podRoundSignup: { count: vi.fn(), upsert: vi.fn(), ...overrides.podRoundSignup },
  }
}
