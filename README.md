# Marmoot

Split the bills you share (groceries, rent, utilities, trips, dinners, game nights) and settle up in the fewest payments, using the payment apps people actually have. Reminders and new expenses go out over WhatsApp in one tap.

**Architecture plan:** [Marmoot — Architecture Plan](https://claude.ai/artifact/SSLhp5ZqqQxMoLDa9Hd8Bz)

## What's here

| Path | What it is |
| --- | --- |
| `packages/core` | Settlement core: money math, expense splits (equal, exact, percent, shares), repeating-bill dates, poker nights, itemized bills, the fewest-transfer solver. No dependencies; runs in Node, Deno (Supabase Edge Functions) and the browser. |
| `apps/web` | The web app (React + Vite, installable on a phone), in light and dark. Groups with expenses, payments, repeating bills and optional game nights; a settle-up plan with pay links; one-tap WhatsApp reminders. Stores groups in the browser until Supabase is connected. |
| `supabase/migrations` | Database schema: groups, people, expenses and their shares, repeating and due bills, poker sessions, an append-only ledger, transfers, row-level security. |
| `supabase/tests` | Database tests against a throwaway Postgres, including SQL vs TypeScript parity on random splits, due dates and poker nights. |

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
- **Repeating bills:** enable the `pg_cron` extension in Supabase, then schedule `select cron.schedule('marmoot-recurring', '17 * * * *', 'select public.catch_up_all_recurring()');`. The app also catches up a group whenever someone opens it.
- Before inviting anyone, set up the nightly backup (the free Supabase plan has none). See "Running free until about 10 users" in the plan.

## How the numbers are kept honest

- Money is integer cents everywhere. Splits use the largest-remainder rule, so shares always add up to the amount paid, to the cent.
- Expenses, the poker event log and the ledger are append-only in the database. An expense is never changed: editing voids it and records a corrected one.
- Splits are computed in Postgres by `split_amount()` and checked against the TypeScript core on hundreds of random splits, including which ones are refused and with what message. Poker results get the same treatment with `poker_nets()`.
- Monthly bills keep their day of the month: rent on the 31st falls on Feb 28 and comes back to the 31st in March.
- The solver is checked against brute force on hundreds of random sessions, with and without payment-app limits.
