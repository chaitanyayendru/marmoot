# Shared bill sheets and WhatsApp messages

Bill sheets work like this. You list what you bought, and everyone on the bill gets a WhatsApp message from Marmoot's own number with a button to their part of the sheet. They untick what they weren't part of (tomatoes yes, onions no), and you watch the answers come in: sent, delivered, read, opened, done. Close the sheet and the totals land in your group.

That needs three free accounts. Do them in this order, because each step uses something from the one before. Set aside about 30 minutes, plus however long Meta takes to approve the message template (often minutes, sometimes a few hours).

| Step | Account | What it's for | Cost |
| --- | --- | --- | --- |
| 1 | Supabase | Stores the sheets and runs the code that sends messages | Free plan |
| 2 | Cloudflare | A public web address, so friends' phones can open their link | Free |
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
2. Open **SQL Editor**, click **New query**, paste the whole of `supabase/setup.sql` from the repo, and click **Run**. You should see "Success. No rows returned". Run it once only.
3. Note two values:
   - **Project URL**: `https://<ref>.supabase.co`. The `<ref>` part is also in the dashboard address, after `/project/`. You need it in step 3.
   - **Publishable key**: under **Project Settings → API Keys**, `sb_publishable_…`. On an older project, use the **anon** key under Legacy API keys.

Both are safe to put in the web app. The database checks every request against the sheet's secret links.

## 2. Cloudflare Pages (the public web address)

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up).
2. In the repo, create the file `apps/web/.env.local` with your two values from step 1:

   ```
   VITE_SUPABASE_URL=https://<ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=sb_publishable_...
   ```

3. Create the site, then publish it:

   ```powershell
   npx wrangler@4 login
   npx wrangler@4 pages project create marmoot --production-branch main
   npm run deploy:web
   ```

   `login` opens your browser to approve. The last command builds the app and prints its address, such as `https://marmoot.pages.dev` (or `marmoot-xyz.pages.dev` if that name is taken).

4. Open that address on your phone. This is now your Marmoot. Your existing groups stay on the device where you made them, so open the new address and create your group there. Add each person's WhatsApp number under **People**, with the country code (+91 for India).

Run `npm run deploy:web` again whenever the app changes.

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

WhatsApp only lets a business start a conversation with an approved template.

1. Go to [business.facebook.com](https://business.facebook.com) → **WhatsApp Manager** → **Message templates** → **Create template**. If you have more than one WhatsApp account, pick the one with the test number.
2. Fill it in exactly:
   - **Category:** Utility
   - **Name:** `bill_ready`
   - **Language:** English (US)
   - **Body:**

     ```
     {{1}} shared a bill with you: {{2}}, {{3}} in total. Tap below to pick the items you were part of. Everyone splits only what they had.
     ```

     Samples: `Chai`, `Costco`, `$33.39`
   - **Button:** Call to action → **Visit website**. Button text `Open the bill`, URL type **Dynamic**, URL `https://<your Cloudflare address>/?s={{1}}`. Sample: `https://<your Cloudflare address>/?s=abc123`.
3. Submit. Wait until its status is **Active**.

### 3c. Give the keys to Supabase and deploy the functions

Replace each `<…>`. `WA_VERIFY_TOKEN` is any long phrase you make up; you'll type it into Meta in 3d.

```powershell
npx supabase@latest login
npx supabase@latest secrets set --project-ref <ref> WA_TOKEN=<access token> WA_PHONE_NUMBER_ID=<phone number ID> WA_APP_SECRET=<app secret> WA_VERIFY_TOKEN=<your phrase>
npx supabase@latest functions deploy send-bill-alerts --project-ref <ref> --no-verify-jwt --use-api
npx supabase@latest functions deploy whatsapp-webhook --project-ref <ref> --no-verify-jwt --use-api
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
4. `npx supabase@latest secrets set --project-ref <ref> WA_TOKEN=<new token>`

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
