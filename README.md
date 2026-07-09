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
npm run prisma:migrate  # applies prisma/migrations/ to your DATABASE_URL, prompts for new ones if the schema changed
npm run dev
```

Only discord-bot should ever call this service — every route except
`/healthz` requires `Authorization: Bearer <BOT_API_KEY>` (see `src/auth.ts`).

### Migrations

Schema changes are tracked as versioned SQL files in `prisma/migrations/`,
generated from `prisma/schema.prisma`. Two different commands, for two
different situations:

- `npm run prisma:migrate` (`prisma migrate dev`) — local development.
  Diffs your schema against the DB, generates a new migration file for any
  change, and applies it. Never run this against a production database —
  it can prompt to reset the DB if it detects drift.
- `npm run prisma:deploy` (`prisma migrate deploy`) — production/CI.
  Applies whatever migrations exist in `prisma/migrations/` that haven't
  run yet. Never generates new migrations or touches existing data beyond
  what the SQL says. This is what a deploy pipeline should run.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every PR:
`npm ci` (also runs `prisma generate` via `postinstall`), typecheck,
lint, test, build, then `npm run prisma:deploy` against a throwaway
Postgres service container — catching a schema change that never got a
migration, or a migration that doesn't actually apply cleanly. This
doesn't deploy anywhere; it's the same verification you'd want before
merging, automated.

## Status

Core loop implemented and tested: account linking (§8.2-§8.3), guild
subscriptions/allowlisting (§7.2), and the full pod-round lifecycle
(§7.5) — `/pods/start` now resolves each target's real broadcast channel
from its `GuildSubscription` and returns it so discord-bot can post there;
`/pods/:id/targets/:guildId/message` records the resulting Discord message
ID; `/pods/:id/signup` returns every target (with its `messageId`) so
discord-bot can fan the updated count out across guilds. Every route
validates its body/params against a Zod schema (`src/validation.ts`) and
400s on malformed input before touching Prisma or PTP.

Known gaps — see `../tasks/` for the full tracked list, most relevant here:

- `/organizers/:discordId/eligible-guilds` returns `guildId` as a
  placeholder `name` — guild display names aren't threaded through from
  Discord yet (`src/routes/organizers.ts`).
- `src/jobs/refreshTokens.ts` is a job body only — not yet attached to a
  scheduler, and has no way to notify an organizer when refresh fails
  (§8.3's DM fallback).
