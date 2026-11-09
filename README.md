# Marmoot

Splitting and settling for groups: poker nights now, itemized restaurant bills next, with payment mapping that finds the fewest transfers between people who actually share a payment app.

**Architecture plan:** [Marmoot — Architecture Plan](https://claude.ai/artifact/SSLhp5ZqqQxMoLDa9Hd8Bz)

## What's here

| Path | What it is |
| --- | --- |
| `packages/core` | Settlement core: money math, poker nights, itemized bills, the fewest-transfer solver. No dependencies; runs in Node, Deno (Supabase Edge Functions) and the browser. |
| `apps/web` | The web app (React + Vite, installable on a phone). Phase 1: run a poker night, from buy-ins to settling up with pay links and a WhatsApp summary. Stores nights in the browser until Supabase is connected. |
| `supabase/migrations` | Database schema: groups, people, poker sessions, an append-only ledger, transfers, row-level security. |
| `supabase/tests` | Database tests against a throwaway Postgres, including SQL vs TypeScript parity on 300 random nights. |

## Run it

Requires Node 22.6 or newer.

```sh
npm install
npm run dev          # web app at http://localhost:5173
npm test             # core, web and database tests
npm run typecheck
npm run build        # production build in apps/web/dist
```

The database tests need Postgres binaries (`initdb`, `postgres`) on your PATH, at `PG_BIN`, or under `/usr/lib/postgresql/<version>/bin`. Without them they skip with a message. To run them against an existing throwaway database instead, set `DATABASE_URL`.

## Deploying for free

- **Web app:** Cloudflare Pages, connected to this repo. Build command `npm run build`, output directory `apps/web/dist`.
- **Database:** a Supabase project on the free plan. Apply the schema with the Supabase CLI: `supabase link --project-ref <ref>` then `supabase db push`.
- Before inviting anyone, set up the nightly backup (the free Supabase plan has none). See "Running free until about 10 users" in the plan.

## How the numbers are kept honest

- Money is integer cents everywhere. Splits use the largest-remainder rule, so totals always match to the cent.
- The poker event log and the ledger are append-only in the database. Mistakes are voided, not edited.
- Each player's result is computed in Postgres by `poker_nets()`, and a test checks it against the TypeScript core on hundreds of random nights.
- The solver is checked against brute force on hundreds of random sessions, with and without payment-app limits.
