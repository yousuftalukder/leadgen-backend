# Phase 69 — the client's workbook: content plan, ad ledger with stock, message templates

## Run

1. **SQL first.** Run `sql/schema-phase69.sql` in the Supabase SQL editor (project `sasbwgollyjpwegsbrty`). It only adds tables, so it is safe to run again.
2. **Then the server** on Render.
3. **Then the pages** on Netlify, which happens by itself on merge.

If the pages arrive before the SQL, the three new tabs say which file to run instead of failing.

The server makes a private storage bucket, `client-library`, the first time someone adds a picture to a template. Pictures are 5 MB at most.

## What changed

A client's page has three new tabs: **Content plan**, **Ad ledger** and **Message templates**. Everything in them is typed in by the team and saved under the client. Anyone on the client can read it, and editors can change it. Business owners don't see these tabs.

### Content plan

- **One row per post:** date, platform, type of post, description (the idea, script or vision), caption, status (Planned, Made, Posted, Skipped), the post's link once it is out, and notes.
- **Paste from a sheet.** Copy the rows from Google Sheets *with the header row* and paste them in. Columns are matched by their header words (date, platform, type, description/script/idea), so the existing form-response sheet works as it is. Dates like `27/10/2026` are read day first. A preview shows how each column was matched before anything is saved.
- **The status changes right in the table.** A post past its date and still "Planned" is shown in red.
- **Ideas from the data,** beside the table and inside the form. These are the briefs from the content plans the tool built for this client from scraped posts: hook, concept, script, caption, why, plus "stop doing" and the caption rules.
  - They are shown, never mixed in.
  - **Use as a start** copies one idea into a new post's form, and the person edits it from there.

### Ad ledger

This is the one-page Ad Ledger, kept in the database instead of a folder on someone's computer. It has four views:

- **Overview**
  - The totals: spent, messages, cost per message, orders, cost per order, sales value, ROAS, message → order.
  - **What needs attention:**
    - stock out;
    - low stock (10 or less);
    - in stock but never advertised;
    - ad fatigue (frequency 3 or more);
    - best ROAS so far.
  - **Next up:** the planned and running ads.
  - **Stock value,** at buying and at customer price.
  - Top creatives by ROAS, cheapest messages, and results by angle.
- **Products & stock**
  - The columns of the stock sheet: SL, product, quantity in hand, in order, buying, customer and combo price. Margin, creatives and ad spend are worked out.
  - **Quantities change right in the table.**
  - **Paste from a sheet** reads the existing stock sheet as it is: "Stock out" becomes 0, "1,490" becomes 1490, and numbered rows with no product are left out.
- **Creatives:** format, angle, date posted, influencer, language, the products shown, the hook and the link.
- **Ads:** each run against a creative, as **Planned next**, **Running** or **Done**.
  - A planned ad needs only a creative or a campaign name, and a budget.
  - Once it has run, type in the results from Ads Manager: spend, reach, impressions, clicks, messages, orders, sales value. Add a verdict and what was learned.

Amounts are in taka.

### Message templates

- **A template** is a title, a group (Price, Delivery, …), the message, and up to 6 pictures.
- **Each template shows as a chat bubble** with **Copy text**, **Copy picture** and **Download** buttons, ready to paste into Meta Business Suite.
- **Copy picture** puts the picture on the clipboard as PNG. Where a browser can't do that, Download still works.
- **The editor shows a live preview.** Pictures can be pasted straight in with Ctrl+V.

### Server

- **New part:** `src/22-client-workbook.js`. The runtime part moves to `src/23-runtime.js`; it registers the `/api` catch-all, so it must stay last.
- **Routes**, all for staff on the client (read: anyone on it; write: editors):
  - `GET /api/clients/:id/workbook?parts=content,products,creatives,ads,templates`
  - `POST /api/clients/:id/workbook/:kind` with one row, or `{ rows: [...] }` for a paste (up to 500 rows)
  - `PATCH` and `DELETE /api/clients/:id/workbook/:kind/:rowId`
  - `POST /api/clients/:id/template-media`: one picture, checked by its bytes
  - `GET /api/clients/:id/workbook-ideas`: read only
- **Every field is checked on the server.** A row is refused, not trimmed, when:
  - a date is not a real date;
  - a number is negative or not a number;
  - a link is not `http(s)`;
  - text is too long;
  - a product, creative or picture belongs to another client.
- **Size limits:** 5,000 rows of each kind per client, and 500 templates.
- **Deleting:**
  - deleting a product takes it off the creatives that showed it;
  - deleting a creative leaves its ads, shown as "Removed creative";
  - deleting a template removes its pictures.
- **Unsaved pictures are cleaned up.** A picture uploaded but never saved on a template is removed after a day.
- **Merging two clients** moves all six new tables.

## Check after deploy

1. Open a client → **Content plan** → Paste from a sheet. Paste the content sheet with its header row. The preview matches Date, Platform, Type of post and Description. Add the rows.
2. Change a post's status in the table. Reload the page; the new status is still there.
3. **Ad ledger** → Products & stock → Paste from a sheet. Paste the stock sheet. "Stock out" rows show the Stock out tag. Change a quantity in the table and press Enter.
4. Add a creative that shows two products. Log a finished ad with spend, messages and orders. Plan one more. The Overview shows the totals, the planned ad under Next up, and the stock warnings.
5. **Message templates** → New template. Add text and a picture, and save. Press Copy text, then paste it into Business Suite. Press Copy picture, then paste that too.
