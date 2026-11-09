# Marmoot

Splitting and settling for groups: poker nights, itemized restaurant bills claimed from a WhatsApp link, and payment mapping that finds the fewest transfers between people who actually share a payment app.

**Architecture plan:** [Marmoot — Architecture Plan](https://claude.ai/artifact/SSLhp5ZqqQxMoLDa9Hd8Bz)

This repo currently holds the settlement core (phase 0 of the plan): pure TypeScript with no runtime dependencies. It runs unchanged in Node and in Deno, the runtime behind Supabase Edge Functions, which is where the API logic lives while Marmoot runs on free tiers (see "Running free until about 10 users" in the plan).

## Run it

Requires Node 22.6 or newer (TypeScript runs directly through Node's type stripping).

```sh
npm install        # TypeScript + @types/node, for the typecheck only
npm test           # 17 tests, including brute-force cross-checks
npm run typecheck
npm run example    # the 8-player poker night from the plan
npm run bench      # solver timings by session size
deno check src/*.ts  # optional: confirms it type-checks under Deno too
```

## What's here

| File | What it does |
| --- | --- |
| `src/money.ts` | Integer cents, and largest-remainder allocation that always adds up to the total |
| `src/poker.ts` | Buy-ins, rebuys, cash paid to the host at the table, cash-outs, chip-count discrepancy handling |
| `src/bill.ts` | Receipt reconciliation, item claims with share weights, tax/tip/service split by claimed subtotal |
| `src/settle.ts` | Greedy settlement, the exact fewest-transfers solver, and the solver limited to payment-app compatibility |
| `scripts/poker-night.ts` | The worked example used in the plan |
| `scripts/bench.ts` | Timing by session size |

## How the solver works

The fewest transfers for n people with non-zero balances is n minus the largest number of separate groups whose balances each add to zero. A zero-sum group of k people settles in k − 1 transfers.

- **No app constraints:** dynamic programming over all 2^n subsets. Exact up to 20 people by default; greedy (at most n − 1 transfers) above that.
- **Payment apps:** a transfer is only allowed between two people who share an app. A zero-sum group settles in k − 1 transfers exactly when its members are linked through shared apps, so the solver maximizes groups that are both zero-sum and linked (3^n over zero-sum subsets). Exact up to 16 people by default. People who are already square are included, because they can bridge two people with no app in common.

Both solvers are tested against independent brute force on hundreds of random sessions (`test/settle.test.ts`).

## Worked example (`npm run example`)

Eight players, $20 buy-ins with rebuys. Two players paid the host in cash at the table, and two players only use Zelle.

- Greedy (biggest debtor pays biggest creditor): **7 transfers**, and 2 of them are between people who share no app.
- Marmoot: **5 transfers**, every one on an app both people have.

## Not built yet

The API service, database schema, receipt extraction, claim page, WhatsApp integration and Excel export. See the build phases in the plan.
