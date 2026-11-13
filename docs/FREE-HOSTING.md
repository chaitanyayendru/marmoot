# Free setup: GitHub Pages and Supabase, no subscriptions

This puts Marmoot on the web for free, for you and your roommates:

- **GitHub Pages** hosts the app at `https://chaitanyayendru.github.io/marmoot/`.
- **Supabase** (free plan) stores the bill sheets, so everyone's ticks meet in one place.
- **Gemini** (free key) reads receipt photos. The key lives only on your phone.
- **WhatsApp:** you post one message in your group, with each person's own link.
- **Splitwise:** no API (that needs Splitwise Pro). Marmoot gives you the exact amounts to type in.

About 15 minutes, once.

## 1. Put the database in Supabase (once)

1. Open your project at [supabase.com/dashboard](https://supabase.com/dashboard) (`crayupizosflqzzweteb`).
2. Go to **SQL Editor → New query**. Open `supabase\setup.sql` from the repo in Notepad, copy all of it, paste it in, and click **Run**. It should say "Success. No rows returned".

Run it only once. Later database changes come as new files in `supabase/migrations`.

## 2. Publish the app on GitHub Pages

1. Push the code from `C:\Users\chait\repos\marmoot`:

   ```powershell
   git push
   ```

2. On GitHub, open the repo's **Settings → General**, scroll to **Danger Zone → Change visibility**, and make it **Public**. GitHub Pages is free only for public repos.
3. **Settings → Pages → Build and deployment → Source:** choose **GitHub Actions**.
4. Open the **Actions** tab. If **Deploy to GitHub Pages** hasn't started, open it and click **Run workflow**. It takes about two minutes.
5. Open `https://chaitanyayendru.github.io/marmoot/`. Every later `git push` to `main` updates it.

There are no secrets to set in GitHub. The Supabase URL and publishable key are already in `.github/workflows/pages.yml`, and both are meant to be public: they ship inside the app to every visitor, and the database decides what they're allowed to do. Never put the database password or an `sb_secret_…` key in the repo.

## 3. On your phone

1. Open the site and add it to your home screen (Safari: Share → **Add to Home Screen**; Chrome: ⋮ → **Add to Home screen**).
2. Get a free Gemini key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). In Marmoot, tap the gear (Settings), paste it, and tap **Save**. It stays on this phone.
3. Make a group with your roommates.

## Use it

1. In the group, tap **Split by item → Scan a receipt** and take a photo. Check the items against the receipt (it tells you if they don't add up), and fix anything it misread.
2. Untick anyone who wasn't on this bill, then tap **Create bill sheet**.
3. Tap **Share in the WhatsApp group** and pick your roommates' group. The message has one link per person.
4. Each roommate opens their link (no app or account needed), unticks what they weren't part of, and taps **Done**. You see their choices on your sheet as they come in.
5. When everyone's done, tap **Copy for Splitwise**. In Splitwise, add an expense for the total, choose **split by exact amounts**, and type in the amounts.

## Next: sign-in and shared groups

To let roommates join your groups and see the same balances on their phones, follow [SIGN-IN-SETUP.md](SIGN-IN-SETUP.md). It's free and takes about 15 minutes more.

## Good to know

- **Supabase pauses a free project after about a week with no use.** The app then can't load sheets. Open the Supabase dashboard and click **Restore project**; your data is kept.
- **Gemini's free tier** allows plenty of receipts for a household. If you hit the limit, wait a minute.
- **Anyone with someone's link can change that person's column.** That's how it works without accounts, so share links only in your group.
- **Prefer to keep the code private?** Use Cloudflare Pages instead (free for private repos): see [SHARING-SETUP.md](SHARING-SETUP.md), step 2.
- **Messages from Marmoot's own WhatsApp number** are still there, but turned off. To turn them on later, finish [SHARING-SETUP.md](SHARING-SETUP.md) step 3, then add a repo variable `VITE_WHATSAPP_SEND` = `1` under **Settings → Secrets and variables → Actions → Variables**.
