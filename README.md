  # PrintFlow — Cyber Cafe Print Management System

A fullstack rebuild of PrintFlow: Node.js/Express + SQLite backend, plain HTML/CSS/JS
frontend (no build step, no framework — safe to edit from Acode). Three roles: super
admin, cafe owner, and customer.

## Deployment

The backend runs on Vercel from `backend/` and the frontend is published to GitHub Pages from `frontend/public/`. In the
GitHub repository settings, add a repository variable named `PRINTFLOW_API_URL`
containing the Vercel backend URL, for example `https://your-project.vercel.app`.
Enable GitHub Pages with the `GitHub Actions` source. Every push to `main` publishes
the `frontend/public/` folder automatically using `.github/workflows/pages.yml`.

On Vercel, set the project Root Directory to `backend`, set `FRONTEND_URL` to the
GitHub Pages URL, then redeploy the backend.

## What changed from the version you uploaded

Your zip had two half-finished folders (`printflow/` and `htm/`) that disagreed with
each other — different CSS approaches, broken absolute asset paths (`/printflow/csd/...`),
a `scan.html` that duplicated the entire 500-line ordering flow instead of reusing it,
and everything running on `localStorage`, so nothing synced between devices and any
customer could edit their own order total in devtools.

This version:

- **Real backend.** Express + SQLite (`better-sqlite3`) with proper tables for users,
  services, and orders. Every device (owner's laptop, customer's phone, your admin
  view) sees the same live data.
- **Real auth.** `bcryptjs` password hashing + `express-session` cookies, not a
  plaintext password check against `localStorage`.
- **Server-side pricing.** Order totals and the platform-fee/payout split are computed
  on the server from the real service prices, so a customer can't tamper with the
  price before checkout.
- **Real file uploads.** Customers now upload the actual document (`multer`, stored in
  `/uploads`), and owners can download it — the old version only ever stored a filename.
- **M-Pesa STK Push — simulated.** There's a clearly-marked simulation in
  `routes/orders.js` (`POST /api/orders/:id/mpesa/stk`) so the whole flow is demoable
  without live Safaricom credentials. Swap that one function for a real Daraja call
  when you're ready to go live; the rest of the app (polling, receipts, payment
  status) doesn't need to change.
- **One ordering flow, not two.** `scan.html` is now just the QR scanner / cafe finder;
  it hands off to `customer-order.html` instead of duplicating it.
- **Removed:** the hardcoded admin password shown on the login screen, the duplicate
  Tailwind-clone `admin.css` file, the dead `/printflow/csd/...` absolute paths, and
  the unused `Disabled` owner status (Active/Suspended covers it, and deleting an
  owner is a separate explicit action).

## Project structure

```
server.js              Express entry point
db/database.js         SQLite schema + connection (creates db/printflow.db on first run)
db/helpers.js          Order-code generation, financial split, response shaping
middleware/auth.js      Route guards (requireAuth / requireRole)
routes/                 auth, services, orders, owners, admin — REST API under /api
public/                 Static frontend (plain HTML/CSS/JS, Tailwind via CDN)
uploads/                Customer-uploaded print files (created automatically)
```

## Running it

```bash
npm install
cp .env.example .env      # then edit SESSION_SECRET and ADMIN_PASSWORD
npm start
```

Open `http://localhost:3000`. A super admin account is seeded automatically on first
run using `ADMIN_EMAIL`/`ADMIN_PASSWORD` from `.env` (defaults to
`admin@printflow.com` / `admin123` — change this immediately in production). Admins
sign in through the same "Sign In" form as owners; the server checks the role and
sends them to the right dashboard.

## Supabase setup

Supabase can provide Auth, database records, and private document storage. Copy the
Supabase values into `backend/.env`, set `SUPABASE_ENABLED=true`, and run
`backend/supabase-schema.sql` once in the Supabase SQL editor. Create a private Storage
bucket named by `SUPABASE_STORAGE_BUCKET` (the template uses `printflowdoc`). The
backend uses the service-role key only; never expose that key in frontend code or commit
it to source control. Existing local JSON/Firebase mode remains available with
`SUPABASE_ENABLED=false`.

## Roles

- **Customer** — no account needed. Scans a cafe's QR code (or finds it via
  `scan.html`), uploads a file, picks services, pays via M-Pesa or cash, gets a
  pickup code and a trackable receipt.
- **Cafe owner** — registers at `index.html`, manages services and pricing, runs the
  five-stage print queue (pending → seen → printing → printed → ready), downloads
  uploaded files, and shares their QR code.
- **Super admin** — approves/suspends cafes, sets subscription plans (Plan A: 10%
  platform fee per order; Plan B: flat fee, no percentage cut), and views
  platform-wide financials and print jobs.

## Notes for deployment

- `db/printflow.db` and `uploads/` are created automatically and are **not** committed
  (see `.gitignore`). Back these up — they're your real data.
- When Supabase is enabled, sessions are persisted in the Supabase-backed records
  table so Render restarts and multiple instances can share login state.
- Set `NODE_ENV=production` and put this behind HTTPS (e.g. via a reverse proxy) so
  session cookies are sent securely.
