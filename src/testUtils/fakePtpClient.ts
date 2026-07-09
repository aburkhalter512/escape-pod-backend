import { vi } from 'vitest'
import type { PtpClient } from '../ptp/client.js'

// Fully satisfies the PtpClient interface, so callers never need
// `as unknown as PtpClient` — every method has a default vi.fn() stub;
// pass overrides for the ones a given test cares about.
export function createFakePtpClient(overrides: Partial<PtpClient> = {}): PtpClient {
  return {
    validateToken: vi.fn(),
    createPod: vi.fn(),
    refreshToken: vi.fn(),
    ...overrides,
  }
}
