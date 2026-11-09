# Getting started

Everything here runs on your own computer for free. Commands are for PowerShell on Windows; they work the same in a macOS or Linux terminal.

Marmoot keeps each person's groups in their own browser. Bill sheets, the shared item-by-item bills with WhatsApp messages, run on a server. `npm run local` runs that server on your computer, so nothing below needs an account. To share sheets with friends for real, follow [SHARING-SETUP.md](SHARING-SETUP.md).

## 1. Install once

| What | Why | Get it |
| --- | --- | --- |
| Node.js 22 LTS or newer (22.6 at least) | Runs the app, the build and the tests | [nodejs.org](https://nodejs.org), the LTS installer |
| Git | You already have it; the repo is a git repo | [git-scm.com](https://git-scm.com) |
| PostgreSQL 16 or newer (optional) | Only for the database tests. The tests start their own throwaway database, so the installer's background service can stay off | [postgresql.org/download/windows](https://www.postgresql.org/download/windows/) |

Check Node in a new PowerShell window:

```powershell
node -v    # v22.6.0 or higher
npm -v
```

## 2. Install the project's packages

```powershell
cd C:\Users\chait\repos\marmoot
npm install
```

This creates `node_modules` (about 130 MB). Run it again whenever `package.json` changes.

## 3. Run the app

```powershell
npm run dev
```

Open http://localhost:5173 and tap **Look around a sample flat first**. Stop the server with Ctrl+C.

### On your phone

```powershell
npm run dev:phone
```

Vite prints a **Network** address such as `http://192.168.1.23:5173`. Open it on a phone on the same Wi-Fi. If Windows Firewall asks, allow Node.js on private networks.

Over plain `http` on your network the phone treats it as an ordinary web page: WhatsApp and payment-app buttons work, but "Add to Home Screen" won't install it as an app. That needs `https`, which the hosted version will have.

### With the server, for bill sheets

```powershell
npm run local
```

This starts a throwaway database, the API, and a pretend WhatsApp inbox at http://localhost:54321/whatsapp. It also starts the app at http://localhost:5173, already connected. It needs PostgreSQL installed (step 1), and downloads PostgREST (about 4 MB) the first time. Ctrl+C stops everything and deletes the data.

### The production build

```powershell
npm run preview
```

Builds the app the way it ships and serves it at http://localhost:4173, including the offline service worker.

## 4. Run the tests

```powershell
npm test            # core, web app and database tests
npm run typecheck   # TypeScript across everything
npm run build       # a production build in apps/web/dist
```

What a good run looks like:

| Suite | Tests | What it checks |
| --- | --- | --- |
| Core (`packages/core`) | 31 | Money math, splits, bill sheet shares, repeating-bill dates, poker nights, the fewest-transfer solver against brute force |
| Web app (`apps/web`) | 13 | Group balances, repeating-bill catch-up, settle-up plans, WhatsApp message text |
| Database (`supabase/tests`) | 23 | The SQL schema and functions against the core: 600 random splits, 300 random poker nights, due dates, voids, bill sheet links and permissions, row-level security |

The database tests look for Postgres in `C:\Program Files\PostgreSQL\<version>\bin` (or `PG_BIN`, or `pg_config` on your PATH). Without it they print "database tests skipped" and the rest still run. To point at a specific install:

```powershell
$env:PG_BIN = "C:\Program Files\PostgreSQL\17\bin"
npm run test:db
```

Run one suite on its own with `npm test -w packages/core`, `npm test -w apps/web` or `npm run test:db`.

## 5. Try it by hand

Start with the sample flat (Home → **Look around a sample flat first**). Each line is something to do and what should happen.

**Groups and expenses**
- [ ] The group opens on your balance in large type, with a line showing how it moved. Green means you're owed; orange-red means you owe.
- [ ] **Electricity** waits at the top as a bill to enter. Type an amount and tap **Add**: it appears under this month's activity and every balance changes. Or tap **Skip**.
- [ ] **Add expense**: enter an amount, pick a category, then try each split.
    - **Equally**: untick someone and the shares update.
    - **Amounts**: enter less than the total and you'll see "$… still to assign."
    - **Percent**: the shares must make 100%.
    - **Shares**: try 1, 1, 2.
- [ ] After adding, **Tell the group** opens WhatsApp with the expense written out. Dismiss the bar with ×.
- [ ] Add an expense with **Repeats: Every month**. It shows under **Repeating bills**. Tick "The amount changes each time" and it will wait for an amount each month instead of posting itself.

**Settling up**
- [ ] **Settle up** shows the fewest payments that clear the group, using only payment apps both people have.
- [ ] A payment you make has **Pay on Venmo** (or PayPal, Cash App) when the person you're paying has added that app under People. It opens the app with the amount and a note filled in. For Zelle it copies their details.
- [ ] A payment owed to you has **Remind <name>**. It opens WhatsApp to that person's own number with what they owe and a pay link. With no number saved, WhatsApp asks which chat to send it to.
- [ ] **Mark paid** or **Mark received** records the payment. Balances drop, and the plan shrinks.
- [ ] **Send the plan to the group** opens WhatsApp with every payment and its pay link.

**People and settings**
- [ ] **People** (the people icon on a group): add a WhatsApp number and payment usernames. A 10-digit US number gets +1 automatically; other countries need their code, like +91.
- [ ] Settings (gear on Home) → **Appearance**: switch System, Light and Dark. System follows your phone or Windows setting.
- [ ] Reload the page: everything is still there. A different browser or phone starts empty, because data stays on each device until accounts arrive.

**Bill sheets** (run `npm run local` first)
- [ ] On a group, tap **Split by item**. Add items with prices (a new row appears as you type), tax, and your name. Tap **Create bill sheet**.
- [ ] The sheet is a grid: items down the side, people across, ✓ or – in each cell with that person's share. Tap any cell to flip it. The totals and tax shares follow.
- [ ] **Send … on WhatsApp**: each person's row goes Message sent → Delivered within a couple of seconds.
- [ ] Open http://localhost:54321/whatsapp and tap **Open the bill** on one message, in a private window. That's their view: one switch per item and their own total. Untick one item and tap **Done**.
- [ ] Back on the sheet, within about 4 seconds: their status reads Read, then Done, their cell shows –, and the activity list says what they changed.
- [ ] **Download** (the arrow at the top) saves an Excel file with the same grid, SUM formulas, and a Changes tab.
- [ ] **Close and add to …** locks the sheet and adds one expense to the group, with each person owing exactly their total. The guest page now says the amounts are final.

**Game night (optional)**
- [ ] **Game night** on a group: pick who's playing, tap buy-ins, then **Cash out** and enter each stack.
- [ ] If the cash-outs don't match the buy-ins within 1% of the pot, it says so before showing results.
- [ ] **See results**, then **Add results to group balances**: each player's result joins the group's balances and its settle-up plan.

Start fresh any time: in the browser, open DevTools (F12) → Application → Local storage → delete `marmoot:v2`.

## 6. If something goes wrong

| You see | Do this |
| --- | --- |
| `running scripts is disabled on this system` (PowerShell) | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use `npm.cmd` in place of `npm` |
| `bad option: --experimental-strip-types` | Node is older than 22.6. Install the current LTS and open a new terminal |
| `Cannot find module @rollup/rollup-win32-x64-msvc` | Delete the `node_modules` folder and run `npm install` again |
| Port 5173 already in use | Vite picks the next free port and prints it; use that address |
| Phone can't reach the Network address | Same Wi-Fi as the computer? Allow Node.js through Windows Firewall on private networks |
| Database tests skipped | Install PostgreSQL 16 or newer, or set `PG_BIN` as above |

## Hosting it for friends

[SHARING-SETUP.md](SHARING-SETUP.md) walks through Supabase, Cloudflare Pages and Marmoot's WhatsApp number, step by step.
