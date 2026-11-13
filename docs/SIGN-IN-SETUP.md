# Sign in with Google, shared groups and invites

Once this is set up, you sign in with Google and your groups move to your account. Roommates join a group with an invite link, someone already in it lets them in, and everyone sees the same expenses and balances on their own phone.

Everything here is free. It takes about 15 minutes, once. You need the [free setup](FREE-HOSTING.md) done first: the app on GitHub Pages and the Supabase database.

## 1. Add the shared-groups part of the database

1. In Supabase, open **SQL Editor → New query**.
2. Open `supabase\migrations\20261113000000_shared_groups.sql` from the repo in Notepad, copy all of it, paste it in, and click **Run**.

If you never ran `supabase\setup.sql`, run that instead. It already includes this part.

## 2. Make a Google sign-in client

1. Go to [console.cloud.google.com](https://console.cloud.google.com). In the project picker at the top, make a **New project** called `Marmoot` and switch to it.
2. Search the top bar for **Google Auth Platform** and open it. If it asks you to get started, use app name `Marmoot`, your email as the support and contact email, and **External** as the audience.
3. Go to **Clients → Create client**:
   - **Application type:** Web application. **Name:** `Marmoot web`.
   - **Authorized JavaScript origins:** `https://chaitanyayendru.github.io`
   - **Authorized redirect URIs:** `https://crayupizosflqzzweteb.supabase.co/auth/v1/callback`
4. Click **Create**, then copy the **Client ID** and **Client secret**. The secret goes only into Supabase in the next step. Never put it in GitHub or the app.
5. Go to **Audience** and click **Publish app**. While the app is in testing, only the test users you list there can sign in. Marmoot asks Google only for your name and email address.

## 3. Turn on Google in Supabase

1. In Supabase, go to **Authentication → Sign In / Providers → Google**. Turn it on, paste the Client ID and Client secret, and click **Save**.
2. Go to **Authentication → URL Configuration**:
   - **Site URL:** `https://chaitanyayendru.github.io/marmoot/`
   - **Redirect URLs → Add URL:** `https://chaitanyayendru.github.io/marmoot/`. Use this exact address with no wildcard: the app always comes back to it after signing in, and remembers on its own whether you were joining a group.
   - To try it from `npm run dev` on your computer, also add `http://localhost:5173/`.

## 4. Use it

1. Open the app and tap the gear, then **Sign in with Google** (or tap **Sign in with Google** under your groups). Your groups move to your account and show "shared" under their name. The sample flat stays on the phone.
2. Open a group and tap the person-with-a-plus icon at the top, then **Share in WhatsApp**.
3. A roommate opens the link and taps **Sign in with Google to join**. Back in the app, they're asking to join.
4. You see "Asha wants to join" at the top of the group. Tap **Let in** and pick who they are. Pick their name if they're already in the list, so the expenses you added for them stay theirs. They go straight into the group.

## Good to know

- **Who can see what:** a group's expenses can be read only by people who have joined it. The tables are closed, and every read and write goes through database functions that check you're in the group.
- **Anyone in a group can add, change and delete its expenses,** like in Splitwise. Each change is kept in order, and nothing is ever overwritten.
- **Offline:** changes you make offline show at once and are sent when you're back online.
- **Leaving:** People → **Leave this group** takes it off your phones. Your past expenses stay in it for everyone else.
- **Signing out** takes shared groups off that phone. Sign back in to get them back.
- **Google's sign-in screen mentions `crayupizosflqzzweteb.supabase.co`.** That's expected: it's the address of your Supabase project.
- **Bill sheets and the receipt scanner work as before.** Roommates still don't need an account just to tick their items on a bill.

## Trying it on your computer

`npm run local` includes a pretend Google: **Sign in with Google** lets you pick Chai, Asha, Ben or any name. Open a second browser, or a private window, to be the roommate.
