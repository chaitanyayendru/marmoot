# Marmoot POC: scan a bill, share a checklist, add it to Splitwise

A proof of concept that runs entirely in your Google account, with no servers to set up:

1. **Scan.** On your phone, photograph the receipt. Gemini reads the items, tax and tip, and you fix anything it got wrong.
2. **Members.** The default list is your Splitwise group. Untick anyone who wasn't on this bill.
3. **Sheet.** Marmoot makes a Google Sheet: items down the side, members across, every box ticked. Totals, tax and tip update as boxes change, and a Done row shows who has checked their column.
4. **Share.** One tap opens WhatsApp with the message ready. Pick your roommates' group and send. They tap the link, pick their name, untick what they didn't have, and tap Done. They can also tick boxes in the Google Sheet directly.
5. **Splitwise.** One tap adds the expense to your Splitwise group: you paid, and each person owes their exact share, to the cent.

The code is four files plus a settings file, in this folder.

## Set it up (about 15 minutes, once)

### 1. Get two free keys

- **Gemini** (reads the receipt): open [aistudio.google.com/apikey](https://aistudio.google.com/apikey), click **Create API key**, and copy it.
- **Splitwise (optional):** Splitwise now allows API access only with a Splitwise Pro subscription. Without it, skip this key: type your roommates' names as the default members instead, and enter the totals in Splitwise yourself. The [web app](../../docs/FREE-HOSTING.md) does the same job with no subscription and copies the exact amounts for you. With Pro, open [secure.splitwise.com/apps](https://secure.splitwise.com/apps) and click **Register your application**. Any name and homepage will do, for example `Marmoot` and `https://example.com`. On the app's page, copy the **API key**.

Keep both private. They go into your own script's settings, and roommates never see them.

### 2. Create the script

1. Go to [script.google.com](https://script.google.com) and click **New project**. Rename it `Marmoot`, top left.
2. Click **Project Settings** (the gear) and tick **Show "appsscript.json" manifest file in editor**.
3. Back in **Editor** (`< >`):
   - Open `appsscript.json` and replace everything in it with this folder's `appsscript.json`.
   - Open `Code.gs` and replace everything with this folder's `Code.gs`.
   - Click **+ → Script**, name it `Logic`, and paste `Logic.gs`.
   - Click **+ → HTML**, name it `Owner`, and paste `Owner.html`.
   - Click **+ → HTML**, name it `Guest`, and paste `Guest.html`.

   Apps Script adds `.gs` and `.html` to the names itself.
4. Press Ctrl+S to save.

### 3. Deploy it as a web app

1. Click **Deploy → New deployment**. Click the gear next to "Select type" and choose **Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**, then click **Deploy**.
3. Google asks you to authorize access to Sheets, Drive and outside services (Gemini and Splitwise). The script is yours, but Google hasn't reviewed it, so you'll see "Google hasn't verified this app". Click **Advanced → Go to Marmoot (unsafe) → Allow**.
4. Copy the **Web app** URL (it ends in `/exec`) and click Done.
5. In the toolbar, pick the function **setup** from the dropdown and click **Run**. The **Execution log** prints your page: `https://script.google.com/macros/s/…/exec?owner=…`

That link is yours alone, because it carries your key. Open it on your phone and bookmark it, or add it to your home screen.

### 4. First time on your page

**Settings** opens by itself. Enter your name and the two keys, and click **Save**. It should then read "Splitwise: connected as …".

## Use it

1. **Scan the receipt.** Check the items against the total line; it tells you if they don't add up. Edit or add items, tax and tip as needed.
2. **Who's in.** Pick the Splitwise group. Everyone in it starts ticked; untick anyone who wasn't there. Check **Paid by**.
3. **Create the sheet → Share in WhatsApp group.** WhatsApp opens with the message ready. Pick the group and send.
4. **Watch Your bills.** Each roommate shows waiting until they tap Done. Tap **Refresh** to update.
5. **Add to Splitwise** once you're happy. If someone hasn't tapped Done, it asks you first. After that the bill is locked, so roommates see the final amounts.

## Changing the code later

After pasting new versions of the files, go to **Deploy → Manage deployments**, click the pencil, set **Version: New version**, and click **Deploy**. The `/exec` link stays the same. Until you do this, the old version keeps running.

## What to know

- **Receipts are read by Gemini's free tier.** It's free within Google's rate limits, and Google's free-tier terms cover what it may do with what you send. Fine for grocery receipts. Always check the items before creating the sheet.
- **There's no login.** Anyone with the roommates' link can tick for anyone, and the Google Sheet link lets anyone edit the sheet. Good enough for roommates, not for strangers.
- **Roommates see a Google banner** on their page saying a Google Apps Script user made it. That's normal for Apps Script web apps.
- **Everyone needs to be in the Splitwise group.** Someone added by hand can still be on the bill, but **Add to Splitwise** refuses unless their share is $0.
- **Don't insert or delete rows in the sheet.** Marmoot reads it back by position. Changing an item name, a price, the tax or the tip in the sheet is fine; Marmoot uses the sheet's values.
- **Each bill is a Google Sheet in your Drive,** named like `Marmoot: Costco (2026-11-12)`.
- **The Splitwise amounts come from Marmoot's own math, to the cent.** The sheet shows exact fractions, so a member's sheet total can differ from Splitwise by a cent.

## For development

- `npm run test:poc` tests the logic, plus the script against stand-ins for Google's services, a pretend Gemini and a pretend Splitwise.
- `npm run poc:dev` serves both pages at http://localhost:8790/exec?owner=dev using those stand-ins. Use the keys `gemini-test-key` and `splitwise-test-key`.
- `npm run poc:formulas` recalculates a bill sheet's formulas in LibreOffice and compares them with Marmoot's amounts.
