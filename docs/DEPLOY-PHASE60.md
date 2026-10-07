# Phase 60 — packages, signed agreements, and invoices

## Run

1. **SQL:** run `sql/schema-phase60.sql` in the Supabase SQL editor (project `sasbwgollyjpwegsbrty`). It is idempotent. It adds:
   - `client_agreements`: one per client
   - `invoices`: numbered INV-0001…
2. Deploy the server (Render), then the pages (Netlify).
3. Open **Team & settings → Packages & billing**. Add your packages, then your agency's details and standard terms. Ways to pay (bKash, bank) are the ones under **Email & sign-ups**. They print on every invoice.

## What changed

- **Packages** (Team & settings → Packages & billing, admins).
  - Each package has a name, a price in ৳, monthly or one-off, what it is, and its deliverables, one per line.
  - The same tab holds your agency name, address, phone, email, standard agreement terms, and a line for the foot of every invoice.
- **Billing in the menu.**
  - **Agreements:** every client, with its packages, its monthly and one-off totals, and its status: none, awaiting signature, or signed (with the date).
    - **Set up** or **Edit** opens the agreement. Add packages from the catalog, or a custom line.
    - Change a price or deliverables for that client only. Set the start date and the terms.
  - **Invoices:** filter by Unpaid, Overdue, Paid, Void or All, and by client.
    - **New invoice** asks which client first. It fills from their agreement (*Monthly fees for October 2026*, *One-off fees*) or by hand.
    - **Mark paid** records how it was paid, for example a bKash TrxID. Paid invoices are locked; mark one unpaid or void it to change it.
- **Invoice page** (`invoice.html`).
  - Shows your details, the client, the dates and the lines, the total, and how to pay.
  - **Print or save as PDF.**
- **The sign-up link carries the agreement.**
  - The invite email and a new sign-in link list the packages and totals.
  - **Invite the owner** says whether the client has an agreement, with a link to set one up.
- **The owner signs first.**
  - When the owner opens the app with an unsigned agreement, the agreement is the app.
  - They see every service, its price, what is delivered, the totals and the terms.
  - They type their full name and tick *I agree*. There is no closing it until they sign.
  - We keep the name, time and IP address, and you see *Signed* in Billing.
  - Changing a signed agreement raises its version, and the owner signs again.
- **Billing in the owner app.**
  - A **Billing** chip, highlighted when something is unpaid, shows their invoices and a copy of the signed agreement.
  - Invoices open inside the app, printable. Void invoices are never shown to them.
- **Client merge** carries invoices along. The target client's own agreement wins.
- **Server:** the billing part is `src/21-billing.js`. The runtime part moves to `src/22-runtime.js`.

## Check after deploy

1. **Team & settings → Packages & billing:** add a package and save.
2. **Billing → Agreements → Set up** on a test client: add the package and save. The status is *Awaiting signature*.
3. Invite yourself as that client's owner and open the link. The agreement shows first. Sign it, and Billing shows *Signed*.
4. **Billing → New invoice** for that client, filled from the agreement. The owner sees it under **Billing** in the app. Mark it paid.
