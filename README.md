# draft-pod-backend

Owns all durable state (organizers, guild subscriptions, pod rounds/targets/
signups) and the Protect the Pod integration. Called by the
[discord-bot](../discord-bot) service's internal API — never talks to
Discord directly.

Design rationale lives in [`../INTEGRATIONS.md`](../INTEGRATIONS.md) — start
with the "Summary" section, then §7.3 (data model), §4.1/§4.1.1 (PTP's own
API surface and its auth boundaries), and §8 (the account-linking flow this
repo's `/organizers/link` route implements).

## Why a separate repo from discord-bot

discord-bot is a thin, stateless Discord-facing edge; this is the actual
brain. See INTEGRATIONS.md §3.4 for why the whole system is a standalone
service rather than a PTP feature, and §8.5 for why credential custody
(PTP tokens carry full account privilege, not just pod-creation) makes
keeping this state in a dedicated, access-controlled service the right
call rather than folding it into the Discord-facing process.

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, TOKEN_ENCRYPTION_KEY, BOT_API_KEY
npm run prisma:migrate  # creates the schema in prisma/schema.prisma
npm run dev
```

Only discord-bot should ever call this service — every route except
`/healthz` requires `Authorization: Bearer <BOT_API_KEY>` (see `src/auth.ts`).

## Status

Scaffolding only. Routes implement the happy path described in
INTEGRATIONS.md §7.5 and §8.2-§8.3; see TODO comments for known gaps,
most notably:

- `/organizers/:discordId/eligible-guilds` returns `guildId` as a
  placeholder `name` — guild display names aren't threaded through from
  Discord yet (`src/routes/organizers.ts`).
- `/pods/start` creates `PodRoundTarget` rows but does not post the actual
  Discord messages — that's discord-bot's job once it has `podRoundId`,
  not yet wired up.
- `src/jobs/refreshTokens.ts` is a job body only — not yet attached to a
  scheduler, and has no way to notify an organizer when refresh fails
  (§8.3's DM fallback).
