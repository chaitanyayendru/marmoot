# Shared bill sheets and WhatsApp messages

Bill sheets work like this. You list what you bought, and everyone on the bill gets a WhatsApp message from Marmoot's own number with a button to their part of the sheet. They untick what they weren't part of (tomatoes yes, onions no), and you watch the answers come in: sent, delivered, read, opened, done. Close the sheet and the totals land in your group.

That needs three free accounts. Do them in this order, because each step uses something from the one before. Set aside about 30 minutes, plus however long Meta takes to approve the message template (often minutes, sometimes a few hours).

| Step | Account | What it's for | Cost |
| --- | --- | --- | --- |
| 1 | Supabase | Stores the sheets and runs the code that sends messages | Free plan |
| 2 | Cloudflare | A public web address, so friends' phones can open their link, rebuilt on every push to GitHub | Free |
| 3 | Meta for Developers | Marmoot's WhatsApp number | Free test number for up to 5 people |

Want to see it all work first, with no accounts? Run `npm run local` (section 0). It runs everything on your computer, with a pretend WhatsApp inbox.

Commands are for PowerShell, run from `C:\Users\chait\repos\marmoot`.

## 0. Try it on your computer first (optional)

Needs PostgreSQL installed (docs/GETTING-STARTED.md, step 1).

```powershell
npm run local
```

The first run downloads PostgREST, the API layer Supabase uses (about 4 MB). Then:

1. Open http://localhost:5173. Tap **Look around a sample flat first**, then **Split by item**.
2. Add a few items and tap **Create bill sheet**, then **Send … on WhatsApp**.
3. Open http://localhost:54321/whatsapp. This is the pretend WhatsApp: the messages Marmoot would have sent, each with an **Open the bill** button.
4. Open one in a different browser, or a private window, so you're "that person". Untick an item and tap **Done**.
5. Back on the first window, the sheet updates within a few seconds: the cell, their status, and the activity list.

Ctrl+C stops it and deletes everything.

## 1. Supabase

1. Go to [supabase.com](https://supabase.com), sign up, and create a **New project**: name it `marmoot`, set a database password (save it), and pick the region nearest you. The free plan is fine.
2. Note two values from the project:
   - **Project URL**: `https://<ref>.supabase.co`. The `<ref>` part is also in the dashboard address, after `/project/`.
   - **Publishable key**: under **Project Settings → API Keys**, `sb_publishable_…`. On an older project, use the **anon** key under Legacy API keys.

   Both are safe to put in the web app. The database checks every request against the sheet's secret links.
3. Put the schema in the project. Skip `supabase init`: the repo already has its `supabase` folder.

   ```powershell
   npx supabase@latest login
   npx supabase@latest link --project-ref <ref>
   npx supabase@latest db push --remote
   ```

   `db push` asks for the database password from step 1 and applies every migration in `supabase/migrations`. Later changes go out the same way.

   No CLI? You can instead paste all of `supabase/setup.sql` into **SQL Editor → New query** and click **Run**, once.

## 2. Cloudflare Pages (the public web address)

With the code on GitHub, let Cloudflare build it on every push:

1. In [dash.cloudflare.com](https://dash.cloudflare.com), go to **Workers & Pages → Create → Pages → Import an existing Git repository**. Connect GitHub, allow access to the `marmoot` repo, and pick it.
2. Build settings:
   - **Project name:** `marmoot` (your address becomes `https://marmoot.pages.dev`, or `marmoot-xyz.pages.dev` if the name is taken)
   - **Framework preset:** None
   - **Build command:** `npm run build`
   - **Build output directory:** `apps/web/dist`
   - **Environment variables:** `VITE_SUPABASE_URL` = your Project URL, `VITE_SUPABASE_ANON_KEY` = your publishable key, `NODE_VERSION` = `22`
3. **Save and Deploy.** The first build takes a couple of minutes. After that, every `git push` to `main` updates the site.

Open the address on your phone. This is now your Marmoot. Your existing groups stay on the device where you made them, so open the new address and create your group there. Add each person's WhatsApp number under **People**, with the country code (+91 for India).

For running the app on your computer against the same database, create `apps/web/.env.local` with those two `VITE_` lines too.

No GitHub? Upload from your computer instead: put the two `VITE_` lines in `apps/web/.env.local`, then run `npx wrangler@4 login`, `npx wrangler@4 pages project create marmoot --production-branch main` and `npm run deploy:web`.

## 3. Marmoot's WhatsApp number (Meta)

### 3a. Create the app and the free test number

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps), log in with Facebook, and click **Create app**.
2. Choose the use case **Connect with customers through WhatsApp** (if asked for an app type instead, choose **Business**). Name it `Marmoot`. If asked for a business portfolio, create one called `Marmoot`.
3. In the app, open **WhatsApp → API Setup**. Meta has created a free test number (it starts +1 555) and shows:
   - **Phone number ID**: copy it.
   - **Generate access token**: click it and copy the token. It lasts 24 hours; 3e explains a permanent one.
4. Under **To**, choose **Manage phone number list** and add up to 5 numbers: yours, Chandu's and Hima's. Each person gets a code on WhatsApp; enter it there.
5. Open **App settings → Basic** and copy the **App secret** (click Show).

### 3b. Create the message template

WhatsApp only lets a business start a conversation with an approved template. This creates it through Meta's API, so there's nothing to fill in by hand. Use the access token and the **Messaging account ID** shown in API Setup, and your Cloudflare address from step 2:

```powershell
$env:WA_TOKEN = "<access token>"
$env:WA_WABA_ID = "<Messaging account ID>"
$env:APP_URL = "https://<your Cloudflare address>"
npm run wa:template
```

It prints `PENDING`, `APPROVED` or why Meta refused it. Run `npm run wa:template` again a few minutes later to check. Meta usually approves within minutes, sometimes a few hours.

It creates this template, if you'd rather check it in WhatsApp Manager → Message templates:
- **Name:** `bill_ready`, **Category:** Utility, **Language:** English (US)
- **Body:** `Hi! {{1}} shared a bill with you: {{2}}, {{3}} in total. Tap below to pick the items you were part of. Everyone splits only what they had.`
- **Button:** Visit website, "Open the bill", dynamic URL `https://<your Cloudflare address>/?s={{1}}`

### 3c. Give the keys to Supabase and deploy the functions

Replace each `<…>`. `WA_VERIFY_TOKEN` is any long phrase you make up; you'll type it into Meta in 3d. These commands use the project you linked in step 1.

```powershell
npx supabase@latest secrets set WA_TOKEN=<access token> WA_PHONE_NUMBER_ID=<phone number ID> WA_APP_SECRET=<app secret> WA_VERIFY_TOKEN=<your phrase>
npx supabase@latest functions deploy send-bill-alerts --no-verify-jwt --use-api
npx supabase@latest functions deploy whatsapp-webhook --no-verify-jwt --use-api
```

`--use-api` means no Docker is needed.

### 3d. Get delivered and read receipts

1. In the Meta app: **WhatsApp → Configuration → Webhook → Edit**.
2. **Callback URL:** `https://<ref>.supabase.co/functions/v1/whatsapp-webhook`. **Verify token:** the phrase from 3c. Click **Verify and save**.
3. Under **Webhook fields**, subscribe to **messages**.

Without this step messages still send, but the sheet only ever shows "Message sent", never delivered or read.

### 3e. A token that doesn't expire

The token from 3a stops working after 24 hours. You'll see "The WhatsApp access token expired" on the sheet. For one that lasts:

1. In [business.facebook.com](https://business.facebook.com): **Settings → Users → System users → Add**, role **Admin**.
2. **Assign assets**: the Marmoot app (full control) and the WhatsApp account.
3. **Generate new token**: pick the Marmoot app, never expire, with permissions `whatsapp_business_messaging` and `whatsapp_business_management`.
4. `npx supabase@latest secrets set WA_TOKEN=<new token>`

## 4. Try it for real

On your Cloudflare address:

1. Open your group, tap **Split by item**, add items, and tap **Create bill sheet**.
2. Tap **Send … on WhatsApp**. Chandu and Hima get a message from the test number with an **Open the bill** button.
3. When they untick items, the sheet updates within a few seconds. Each person's row shows sent → delivered → read, then opened → done.
4. **Close and add to …** puts the result in your group's balances.

If someone's message fails, their row says why in plain words (for example, a number that isn't on the test list) and offers **Resend**. **Link** copies their personal link, if you'd rather send it yourself.

## Limits to know

- **The test number reaches only the 5 numbers you verified,** and shows as a test sender rather than "Marmoot". For everyone else, add a real number under **WhatsApp → API Setup → Add phone number**:
  - Use a spare SIM or number that isn't already on WhatsApp.
  - Meta approves the display name "Marmoot", and you add a payment method in WhatsApp Manager.
  - Change `WA_PHONE_NUMBER_ID`, and create `bill_ready` again if it doesn't show under the new account.
  - Each delivered message then costs about $0.0034 to a US number and $0.0014 to an Indian one, at Meta's utility rates. That's cents a month for 10 people.
- **Meta's rules say each person should agree to get messages from Marmoot.** With friends, ask them first.
- **Anyone with your Marmoot address can create a sheet.** That's fine while the address is private and the test number limits who can be messaged. Before you add a real number and share the address widely, sign-in should be required to create sheets; that comes with accounts.
- **Only bill sheets send from Marmoot's own number so far.** The settle-up reminders still open WhatsApp on your phone. Moving those onto the server is the next step.
- **Each person's link is their key to their column.** Anyone they forward it to can change their choices. Every change is in the activity list with who made it.
