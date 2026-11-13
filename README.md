# Marmoot

Split the bills you share (groceries, rent, utilities, trips, dinners, game nights) and settle up in the fewest payments, using the payment apps people actually have.

For a shop with many items, make a **bill sheet**: scan the receipt, then post one WhatsApp message in your group with each person's own link. Each person unticks what they weren't part of (tomatoes yes, onions no). You see who's answered, and the totals land in the group when you close it, ready to copy into Splitwise as exact amounts.

## What's here

| Path | What it is |
| --- | --- |
| `packages/core` | Settlement core: money math, expense splits (equal, exact, percent, shares), repeating-bill dates, poker nights, itemized bills, the fewest-transfer solver. No dependencies; runs in Node, Deno (Supabase Edge Functions) and the browser. |
| `apps/web` | The web app (React + Vite, installable on a phone), in light and dark. Groups with expenses, payments, repeating bills and optional game nights; a settle-up plan with pay links; one-tap WhatsApp reminders. Stores groups in the browser until Supabase is connected. |
| `supabase/migrations` | Database schema: groups, people, expenses and their shares, repeating and due bills, poker sessions, an append-only ledger, transfers, bill sheets with per-person links, the WhatsApp outbox, row-level security. `supabase/setup.sql` is all of it in one file for a new project. |
| `supabase/functions` | Edge Functions: `send-bill-alerts` sends the WhatsApp template from Marmoot's number; `whatsapp-webhook` records delivered, read and failed. |
| `supabase/local` | `npm run local`: the whole server on your computer (Postgres, PostgREST, the functions, a pretend WhatsApp inbox) plus the app, for trying bill sheets with no accounts. |
| `supabase/tests` | Database tests against a throwaway Postgres, including SQL vs TypeScript parity on random splits, due dates and poker nights, and bill sheet permissions. |
| `docs` | [Getting started](docs/GETTING-STARTED.md) on Windows, the [free setup](docs/FREE-HOSTING.md) on GitHub Pages and Supabase, and [Marmoot's own WhatsApp number](docs/SHARING-SETUP.md). |

## Run it

Step-by-step setup for Windows, testing on your phone, a hand-testing checklist and fixes for common errors: **[docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)**.

Requires Node 22.6 or newer.

```sh
npm install
npm run dev          # web app at http://localhost:5173
npm run dev:phone    # the same, reachable from a phone on your Wi-Fi
npm run local        # the app plus its server and a pretend WhatsApp, for bill sheets
npm run preview      # production build served at http://localhost:4173
npm test             # core, web and database tests
npm run typecheck
npm run build        # production build in apps/web/dist
```

The database tests start a throwaway Postgres 16+ from `PG_BIN`, `pg_config` on your PATH, or the usual install folders (`C:\Program Files\PostgreSQL\<version>\bin` on Windows). Without one they skip with a message. To run them against an existing throwaway database instead, set `DATABASE_URL`.

## Deploying for free

[docs/FREE-HOSTING.md](docs/FREE-HOSTING.md) has every step, with no subscriptions:
- **GitHub Pages** for the web app, built on every push (`.github/workflows/pages.yml`).
- **Supabase** (free plan) for the bill sheets.
- **Gemini** (free key, kept on the phone) for reading receipts.

Optional, in [docs/SHARING-SETUP.md](docs/SHARING-SETUP.md): Cloudflare Pages instead of GitHub Pages (works with a private repo), and messages from Marmoot's own WhatsApp number (Meta's free test number covers 5 people).

Before inviting more people, set up the nightly backup (the free Supabase plan has none), and require sign-in to create sheets.

## How the numbers are kept honest

- Money is integer cents everywhere. Splits use the largest-remainder rule, so shares always add up to the amount paid, to the cent.
- Expenses, the poker event log and the ledger are append-only in the database. An expense is never changed: editing voids it and records a corrected one.
- Splits are computed in Postgres by `split_amount()` and checked against the TypeScript core on hundreds of random splits, including which ones are refused and with what message. Poker results get the same treatment with `poker_nets()`.
- Monthly bills keep their day of the month: rent on the 31st falls on Feb 28 and comes back to the 31st in March.
- The solver is checked against brute force on hundreds of random sessions, with and without payment-app limits.
