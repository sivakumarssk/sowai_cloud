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
| Engine (`decide.ts --live`) | refuses | off for now: `sowsi-engine` isn't running, and no deploy step starts it |
| Seed | `npm run db:seed` (demo admin with a known password) | `npx tsx scripts/prod/seed.ts` (plans only: no node, no users) |
| Database | the **old** database | a **new**, empty database |

### Layout

```
your machine (development)            sowsi-mgmt-01 2.31.11.105 (production)
  webnext/ · APP_ENV=development        /var/www/sowsicloud · APP_ENV=production
  rzp_test_ keys                        rzp_live_ keys, Razorpay webhook → /api/payment/webhook
  DATABASE_URL → old database           DATABASE_URL → new database
                                        PM2: web app (sowsi-engine stays off)
                                        cron: POST /api/cron/billing every 5–15 min
                                        reaches Proxmox :8006 (closed to everything else)

sowsi-proxmox-NN (Hetzner, nbg1, installed by scripts/node/install-node.ts): LXC containers, one Floating IP each
sowsi-proxmox-01 128.140.70.53: the hand-built first node, retired (row kept as DECOMMISSIONING, server deleted)
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
6. **Build and switch:** `npm run build && pm2 restart <web app>`
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
npm run test:engine && npm run build && pm2 restart <web app>
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

## Adding a Proxmox node

`scripts/node/install-node.ts` turns a fresh Debian 12 Hetzner Cloud server
into a Proxmox node. It runs only on sowsi-mgmt-01 with `APP_ENV=production`,
one at a time, and isn't wired to the engine or approvals yet.

```bash
npx tsx scripts/node/hetzner-check.ts --type cpx22                                                           # read-only: every Hetzner endpoint we use
npx tsx scripts/node/install-node.ts --name sowsi-proxmox-02 --type cpx22                                    # plan: cost, checks
npx tsx scripts/node/install-node.ts --name sowsi-proxmox-02 --type cpx22 --execute --approved-by <you>      # buy + install (~25 min)
npx tsx scripts/node/install-node.ts --destroy <hetznerServerId> [--execute --approved-by <you>]             # remove a throwaway node
```

- **What it does:**
  1. Buys the server, checked against the monthly spend cap. Availability and
     price are read from the type's entry for nbg1; if they can't be read,
     nothing is bought.
  2. Turns on the firewall, then installs Proxmox, so port 8006 is never open
     to the internet.
  3. Proves the node works with a test container, then deletes the container.
  4. Registers the node **closed**: status PROVISIONING, `acceptNewClients=false`.
- **Re-runs and failures:** re-running with the same `--name` resumes at the
  first unfinished step. Any failure deletes the server and its Primary IPs,
  unless you pass `--keep-on-failure`.
- **Three layers protect the first reboot:**
  1. The card's name is pinned by MAC (a `.link` file, in every initramfs).
  2. A boot-time guard (`sowsi-net-guard.service`) corrects vmbr0 if the node
     can't reach anything after 90 seconds, then falls back to DHCP for that
     boot. It does nothing when the network works. Log:
     `/var/log/sowsi-net-guard.log`.
  3. If the node still never answers, the installer power-cycles it into the
     Hetzner rescue system, saves diagnostics to `/root/node-diagnostics/`, and
     repairs the network once if the evidence supports it, then resumes. Rescue
     is downtime, so a node holding customers is refused unless you pass
     `--allow-downtime`.
- **First boot is IPv4 only,** as on the hand-built first node. IPv6 is added once SSH is back.
- **Opening and retiring:** a new node registers closed. `scripts/node/node-state.ts --name <node> --open`
  opens it for orders; `--retire` takes one out of service (status DECOMMISSIONING) and keeps its row
  and history. Both are dry runs unless `--apply --approved-by <name>`. Retiring refuses while the node
  has a live service, a volume, an open migration or an open approval. Nodes never come from `.env`:
  each has its own address and API token on its row, and a node without a token is refused.
- **DNS is a plain `/etc/resolv.conf`,** written before the reboot and checked
  again after it. The image's link into `/run` is empty after a reboot once
  DHCP is gone. vmbr0 also carries `dns-nameservers` with the same servers: it
  does nothing while the file is plain, and is the fallback if the link returns.
- **SSH keys:** Hetzner adds the install and admin keys when the server is
  created, Proxmox adds a root key of its own, and the installer adds the
  restricted provisioning key and removes the install key. Step 3j lists
  `authorized_keys` by fingerprint and fails on anything else.
- **Re-using a name:** a name whose install was destroyed or failed gets a new
  row and a new server, and the plan says so. The old record is kept as
  `<name>#<serverId>`.
- **Container isolation:** `sowsi-routes` keeps two nftables tables, `bridge
  sowsi` and `inet sowsi`, generated from each container's `net0` line and kept
  apart from UFW. A container can send only from its own MAC and IPs, can't
  reach another container or anything on the host, can leave only by the public
  uplink, and can't send on ports 25 and 465. A container without valid rules
  gets no traffic. Step 4 proves this with two test containers before the node
  registers. Their `198.18.254.x` addresses are never routed: they let the host
  see IPv4 from them without buying a Floating IP. `isolation-status` on the
  dispatcher prints the rule counters. `isolation-report` prints the rules,
  counters, ports, `net0` lines and the rules' journal, and changes nothing.
  After restarting one test container, step 4 waits for its address and route
  and learns the gateway from its real address. It then proves `spoof_ip4` and
  `spoof_arp` separately: with the gateway unknown, a spoofed packet goes out
  first as an ARP request, which only `spoof_arp` sees. If step 4 fails, the
  installer saves what the test containers and `isolation-report` show to
  `/root/node-diagnostics/<server>-<time>-verify.txt` on the machine running it. With `--keep-on-failure` it
  keeps the test containers and their Floating IP (which is billed) for
  inspection. A re-run deletes them first. `scripts/node/isolation-compare.sh` and
  `baseline-compare.sh` only read, for comparing a node with a fresh one.
  `isolation-test.sh` is the full test for a throwaway node, and refuses a node
  without "test" in its name.
- **Shared IPv4, Stage A (private addresses and NAT):** a service in shared mode gets one private
  address from `100.64.0.0/10`, assigned once from a database sequence and never reused
  (`src/lib/provisioning/privateIpv4.ts`). `100.127.255.0/24` is kept for test containers. In the
  `inet sowsi` table, `shared_out` masquerades that range to the node's IPv4 on the uplink only
  (counter `nat_out`). New connections from outside to the range are dropped (`shared_in`).
  Isolation is unchanged: each shared container's chain allows only its own private address. Step 4's
  neighbour container uses `100.127.255.11`, so every install proves outbound IPv4 through NAT
  without buying an IP. Nothing uses shared mode yet: until the add-on is live, every new service
  is `DEDICATED` with its own Floating IP. ROADMAP.md tracks the stages.
- **Shared IPv4, Stage B (the gateway):** each node has HAProxy in container 9000 (`sowsi-gateway`,
  hostname `sowsi-gateway`) on a Floating IP of its own, bought by the installer's gateway step
  under the spend cap and labelled `sowsi-node-install=gateway`. Port 80 is routed by Host, 443 by
  the TLS name without decrypting; an unknown name gets a neutral 404 on 80 and a closed
  connection on 443. `sowsi-gateway sync <version>` (dispatcher: `gateway-sync <version>`, the table
  on stdin) checks every line, generates the config itself, runs HAProxy's config test, reloads
  gracefully and goes back to the last good version if the new one doesn't serve.
  `sowsi-gateway status` (`gateway-status`) prints its facts. The node's rules let the gateway reach
  shared containers on 80 and 443 only. The gateway never counts towards `maxContainers`, and
  `--destroy` releases its Floating IP with the server.
- **Throwaway tests:** `--simulate-bad-nic` points the bridge at a card that
  doesn't exist before the reboot (the `--name` must contain `test`). Add
  `--no-guard` to prove the rescue repair instead of the guard.
- **Spend cap:** the monthly price counts while a node stays. A destroyed server
  counts only the started hours it lived.
- **Settings it needs in `.env`:** `MGMT_PUBLIC_IP` and
  `NODE_ADMIN_SSH_PUBLIC_KEY` (see `.env.example`).
- **VM ids repeat across nodes**, so a VM id means nothing without its node.
  Scripts taking `--vmid` need `--node` once there's more than one node.
- **Opening the node:** only once you're happy with it.
  ```sql
  update "ProxmoxNode" set status = 'READY', "acceptNewClients" = true where name = 'sowsi-proxmox-02';
  ```

Reading the database on sowsi-mgmt-01 (`psql` doesn't accept `?schema=`):

```bash
DB=$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"' | sed 's/?.*//')
psql "$DB" -c 'select name, status, "acceptNewClients", "physicalRamMB", "physicalDiskGB" from "ProxmoxNode";'
```

Checking port 8006 from a Windows laptop (must print `TcpTestSucceeded : False`):

```powershell
Test-NetConnection <node ip> -Port 8006
```

## Rollback

- **Code only:** the schema changes are additive, so older code runs on the
  new schema.
  ```bash
  git log --oneline -5                     # pick the last good commit
  git checkout <sha> && npm ci && npm run build && pm2 restart <web app>
  ```
  Go back to `master` afterwards with `git checkout master`.
- **Back to the old database:**
  1. `cp .env.old-db .env`.
  2. Make sure it says `APP_ENV=production` and `PROVISIONER=proxmox`, or the
     app refuses to start.
  3. Run `npm run build && pm2 restart <web app>`.
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
