# Sowsi Cloud

VPS and S4 hosting: a Next.js 16 app (customer site, dashboard, admin, Razorpay
billing) plus a resource engine that watches and scales Proxmox containers.
Postgres via Prisma 7.

- Design rules: [DESIGN.md](DESIGN.md)
- Every environment variable: [.env.example](.env.example)

## Environments

Every process (the web app, `next build`, the engine and every script) reads
`APP_ENV` first and refuses to start if the rest of `.env` doesn't match it
(`src/lib/environment.ts`).

| | Development | Production |
|---|---|---|
| `APP_ENV` | `development` | `production` |
| Razorpay | `rzp_test_` keys only | `rzp_live_` keys only |
| `PROVISIONER` | `simulated` (never builds a server, never shows an IP) | `proxmox` |
| Hetzner / Proxmox tokens | refused unless `ALLOW_REAL_INFRA=1` | required |
| Billing cron (`/api/cron/billing`) | refuses (503) | runs |
| Engine (`decide.ts --live`) | refuses | runs (PM2 `sowsi-engine`) |
| Seed | `npm run db:seed` (demo admin with a known password) | `npx tsx scripts/prod/seed.ts` (plans and node only, no users) |
| Database | the **old** database | a **new**, empty database |

### Layout

```
your machine (development)            sowsi-mgmt-01 2.31.11.105 (production)
  webnext/ · APP_ENV=development        /var/www/sowsicloud · APP_ENV=production
  rzp_test_ keys                        rzp_live_ keys, Razorpay webhook → /api/payment/webhook
  DATABASE_URL → old database           DATABASE_URL → new database
                                        PM2: web app, sowsi-engine (decide.ts --live)
                                        cron: POST /api/cron/billing every 5–15 min
                                        reaches Proxmox :8006 (closed to everything else)

sowsi-proxmox-01 128.140.70.53 (Hetzner CPX32, nbg1): LXC containers, one Floating IP each
```

**The old database holds one real client** with a live Razorpay subscription.
Keep it, and don't delete his rows: it is the source for
`scripts/prod/import-client.ts`. Nothing in development can charge, suspend or
delete him. Development has only test keys, and the billing cron and the
engine refuse to run there.

## Deploy order (first production deploy)

Run all of this on sowsi-mgmt-01 in `/var/www/sowsicloud`.

1. **Back up both databases:**
   `pg_dump "$OLD_DB" > old-$(date +%F).sql` (and the same for the new one once
   it exists).
2. **Create the new database** (empty) and point the production `.env` at it.
   - `DATABASE_URL=<new database>`
   - `APP_ENV=production`
   - `PROVISIONER=proxmox`
   - `RAZORPAY_KEY_ID`, `NEXT_PUBLIC_RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` set to the live keys
   - `RAZORPAY_WEBHOOK_SECRET` set to the live webhook's secret
   - The Proxmox, Hetzner and SSH key settings, as before.
   - Keep the old `.env` as `.env.old-db` for rollback.
3. **Code and schema:**
   ```bash
   git pull && npm ci
   npx prisma migrate deploy && npx prisma generate
   npm run test:engine
   ```
4. **Catalog:** `npx tsx scripts/prod/seed.ts`
   - It upserts the plans and the ProxmoxNode, and creates no users.
   - Then run `npx tsx scripts/engine/watchServers.ts --live --once` to measure the node.
5. **Import the real client.** Do this before the app switches over, so his
   next autopay webhook finds him:
   ```bash
   npx tsx scripts/prod/import-client.ts --from "$OLD_DB" --email <his email>             # plan, changes nothing
   npx tsx scripts/prod/import-client.ts --from "$OLD_DB" --email <his email> --execute   # copy
   ```
   - Check that every line under his `sub_…` id is ✓.
   - His service arrives as a **manual server on billing hold**, shown to him as
     "Setting up".
6. **Build and switch:** `npm run build && pm2 restart <web app> sowsi-engine`
   (`pm2 ls` shows the names). The build refuses if the environment is wrong.
7. **Admin:** sign up on the site, then run
   `npx tsx scripts/prod/make-admin.ts <your email>`. Sign out and back in.
8. **His server:** go to Admin → Servers → **Assign server** and enter the
   server's IP and login.
   - The service becomes ACTIVE only if an SSH login with those details works.
   - Every attempt is in that page's audit log.
   - **Release hold** there once his billing is checked: payment recorded,
     paid-until date right.
9. **Cron:**
   ```
   */5 * * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/billing
   ```
   It must return JSON, not `Refusing to run`.
10. **Check:**
    - The Razorpay dashboard → Webhooks shows 200s.
    - `EngineLog` has no `WEBHOOK_UNKNOWN` rows, or only ones you expected.

### Later deploys

```bash
git pull && npm ci && npx prisma migrate deploy && npx prisma generate
npm run test:engine && npm run build && pm2 restart <web app> sowsi-engine
```

## What protects paying clients

- **ACTIVE means a real server.** The database constraint
  `Service_active_requires_real_server` requires a passed SSH check, plus either
  a Proxmox container with its node and Floating IP, or a manual server's IP.
  Clients see an IP and credentials only for such servers.
- **Unknown Razorpay webhooks:** a subscription, payment or order this database
  doesn't know is logged (`EngineLog` `WEBHOOK_UNKNOWN`) and emailed with every
  Razorpay id. The webhook still answers 200, and nothing is changed.
- **Paid without a server:** a successful payment with no server after 10
  minutes alerts once (`PAID_NO_CONTAINER`).
- **Billing hold:** services on hold are never suspended or deleted
  automatically. A halted autopay emails an admin instead. Payments and
  renewals are still recorded.
- **Rebuilding a paid service** that has no server:
  `npx tsx scripts/billing/reprovision.ts --service <id>` (plan), then add
  `--execute --by <name>`. It never touches payments, subscriptions or refunds.

## Rollback

- **Code only:** the schema changes are additive, so older code runs on the
  new schema.
  ```bash
  git log --oneline -5                     # pick the last good commit
  git checkout <sha> && npm ci && npm run build && pm2 restart <web app> sowsi-engine
  ```
  Go back to `master` afterwards with `git checkout master`.
- **Back to the old database:**
  1. `cp .env.old-db .env`.
  2. Make sure it says `APP_ENV=production` and `PROVISIONER=proxmox`, or the
     app refuses to start.
  3. Run `npm run build && pm2 restart <web app> sowsi-engine`.
  4. Then reconcile by hand. Anything recorded in the new database after the
     switch isn't in the old one:
     ```sql
     -- run on the NEW database
     select "razorpayPaymentId", "subscriptionId", amount, status, "createdAt" from "Payment" where "createdAt" > '<switch time>';
     select "razorpaySubscriptionId", status, "paidCount", "currentEnd" from "Subscription";
     ```
- **A bad import:** restore the new database from step 1's backup. The source
  is never written; the import opens it read-only.
- Never cancel or refund in Razorpay as part of a rollback. Autopay keeps
  charging the same subscription whichever database records it.

## Development

```bash
cp .env.example .env    # APP_ENV=development, PROVISIONER=simulated, rzp_test_ keys
npx prisma migrate deploy && npm run db:seed
npm run dev
npm run test:engine     # unit tests (node:test via tsx)
```

To run engine scripts against the real Proxmox or Hetzner from development,
set `ALLOW_REAL_INFRA=1`. Paid orders still only simulate; the engine and the
billing cron still refuse.
