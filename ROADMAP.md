# Sowsi Cloud roadmap

Updated at the end of every round. Order of work before launch: **1** shared IPv4 gateway,
**2** DNS, **3** dynamic allocation, **4** Stage 3. Each stage is tested on a throwaway node,
committed, and stops for review before the next one starts.

## Done

**Site, catalog and payments**
- Marketing site, plan pages, pricing, privacy policy (Oct 2026).
- Razorpay checkout and webhooks; plan prices with intro, renewal, GST and the 2% charges.
- Truth pass: claims the product doesn't deliver were removed from the site.


**Environments and data safety**
- `APP_ENV` development | production, checked by the app, every script, the billing cron and the
  engine. Development: test keys, simulated provisioner, no real infrastructure tokens.
- Fresh production database. The old one is development, and holds the one real client's rows.
- ACTIVE requires a real server (database constraint, mirrored in `serverReady.ts`).
- Manual servers (assigned by an admin after an SSH check) and `billingHold` for imported clients.
- `scripts/prod/import-client.ts` for the real client.

**Resource engine (built, OBSERVE only; `sowsi-engine` stays off)**
- Monitors, RAM scaler, disk expander, Volume manager, decision maker, approvals, ₹5,000 spend cap.
- Node-aware suspend, resume, cancel and reprovision; VM ids repeat across nodes safely.
- Host RAM reserve, node capacity report and unit economics per plan.

**Nodes**
- `scripts/node/install-node.ts`: buys a Hetzner server, installs Proxmox, survives the first
  reboot (card name pin, boot guard, rescue repair), DNS, IPv6, firewall, host setup, key audit,
  step 4 test containers with the isolation proof, and registers the node closed.
- Network isolation for containers, proven on real hardware (sowsi-test-03): anti-spoofing,
  neighbours, host, private networks, mail ports, metadata, other interfaces, after a restart and
  a reboot. `isolation-report` and step 4 diagnostics; `--keep-on-failure` keeps test containers.
- `hetzner-check` (read only): every endpoint we use, invoice facts, Floating IP flags,
  `--expect-gone`.
- Node 1 (sowsi-proxmox-01) retired and deleted. `scripts/node/node-state.ts --retire | --open`.
  No node comes from `.env`: each has its own address and API token on its row.
- Invoice facts recorded: 20 TB traffic a month per CPX server, then $1.20/TB; Floating IPv4
  $0.0056/hour, at most $3.50 a month.

**Shared IPv4 gateway, Stage A: private IPv4 per service and NAT** (proven on sowsi-test-04, 11 Nov 2026)
- Each service can hold a private IPv4 from `100.64.0.0/10`, from a sequence, never reused;
  `100.127.255.0/24` is kept for tests. A Proxmox service may be ACTIVE with a Floating IP, or in
  shared mode with a private IPv4 (database constraint and `serverReady.ts`).
- NAT in the sowsi tables (`shared_out`, counted as `nat_out`); new connections from outside to the
  range are dropped (`shared_in`); the range is a private destination containers can't send to.
- Installer step 4 proves it: the second test container is at `100.127.255.11` and reached the
  internet over IPv4 through NAT (nat_out 0 → 3).
- isolation-test.sh: 65 passed, 1 failed (test 16, the test itself: see Stage B). Test 27, all 6;
  reboot-check, 14 passed, including NAT after the reboot. Destroy and `--expect-gone` clean.
- Every service still defaults to a dedicated IPv4.

**Shared IPv4 gateway, Stage B: the gateway container** (proven on sowsi-test-06, 12 Nov 2026)
- `sowsi-gateway` on each node: HAProxy in container 9000 on a Floating IP of its own. Port 80 by
  the Host header, 443 by the TLS name, passed through still encrypted. Unknown name: a neutral 404
  on 80, a closed connection on 443. The client's own X-Forwarded-For is dropped.
- `sync <version>`: the whole table on stdin, every line checked, size-capped, older versions
  refused; HAProxy's config test, a graceful reload, proof the new version serves, else back to the
  last good. HAProxy is restarted onto our config whenever the running master isn't on it (the
  sowsi-test-05 failure: a reload keeps the config apt started it with). Dispatcher:
  `gateway-status`, `gateway-sync <version>`.
- Rules: the gateway reaches shared containers on 80 and 443 only; containers reach it on 80 and
  443 only. The card's name pin matches `Type=ether`, so it never applies to vmbr0.
- Installer: the gateway step (its Floating IP under the spend cap), step 4 routes two names to two
  containers from outside, the node registers with its gateway; `--destroy` releases the labelled
  Floating IPs.
- sowsi-test-06: install steps 1 to 5 passed (vmbr0 check, HAProxy on our config, one/two.gateway.test
  to containers 101/102 on 80 and 443, X-Forwarded-For replaced, unknown name 404 / closed, routes
  removed). Hashes 9b7d355f / 24037d7f / 2b1e5536; 0 vmbr rename attempts. isolation-test.sh main:
  81 passed, 1 failed (test 16, the test's own bug: see below); test 28 all 16. Reboot-check: 21
  passed, gateway status unchanged but for memory, 404 after the reboot.
- Test 16 named its Docker container `t`; Docker wants two characters or more, so every run failed
  with "Invalid container name (t)". Now `sowsi-test16`, with a test of the generated commands and a
  fake docker that refuses names the way Docker does.

## In progress

**1. Shared IPv4 gateway — Stage C: shared mode in provisioning.** Built and tested locally; waiting
for the throwaway-node test (done when a simulated order ends ACTIVE as shared on it).
- First run (sowsi-test-07, server 175974701, 12 Nov 2026): install, `--shared on` and the gateway
  sync (0 routes) were fine, but the test order was refused: "sowsi-test-07 is PROVISIONING".
  The installer registers a node PROVISIONING and closed, and a pinned order still treated that as
  closed. Fixed: a pinned test order takes a closed node, PROVISIONING included, and refuses an
  open one (real orders land there) or a retired one. Customer orders are unchanged.
- Per-node flag `ProxmoxNode.sharedIpv4` (off by default; `node-state.ts --shared on|off`; on needs
  the gateway). Placement sends a shared order only to a node with the flag and a gateway.
- A shared service buys no Floating IP: its private address, a name under `c.sowsicloud.com`
  (`publicName`: the order's hostname, or with a short suffix when taken or reserved; unique, never
  reused) and a 16-character route key. Setup logs in over its IPv6. ACTIVE in shared mode now also
  needs the name and key (constraint and `serverReady.ts`). A Coolify server stays dedicated.
- Gateway sync: the node's whole table (shared services ACTIVE or SUSPENDED) after a service becomes
  ACTIVE, before a cancelled one's container goes, and every 5 minutes from
  `scripts/node/gateway-sync.ts --cron` (alerts at most once an hour per node). Versions are taken
  under the node row's lock (`gatewayRoutesIssued`), so a later version always carries a later table;
  "older than applied" means a newer table is already there.
- One connection helper, `serviceConnection()`: Shared or Dedicated with its IPv4, IPv6, SSH command
  and notice, used by the dashboard, the progress page, the ready email, the status APIs and the admin
  list. A manual server is always Dedicated. The service name isn't shown as an address until its DNS
  exists (Stage D).
- `scripts/node/shared-test-order.ts`: the proof on a closed throwaway node. A made-up customer
  (`.invalid`, no login, no mail), no payment, billingHold on, refunds and emails off, pinned to the
  node; checks ACTIVE as shared with nothing bought, its net0, the gateway's route, a web server
  reached by its name on 80 and 443 through the gateway, IPv4 out by NAT; `--cleanup` cancels it and
  deletes the rows.
- Every customer order is still DEDICATED, and nothing a customer does can make one shared (a test
  checks that only the test-order script writes SHARED).
- Not changed (billing): `scripts/billing/reprovision.ts` and `reprovisionDeps.ts` look up Floating
  IPs; a shared service would need them to allow none. No shared customer service exists before
  Stage G, so this waits for your OK to touch billing code. `capacityReport.ts` doesn't yet show
  shared and dedicated costs separately (Stage G).

## Pending

**1. Shared IPv4 gateway** (design: "Shared IPv4 Gateway Design", with your answers of 11 Nov 2026)
- Stage F: abuse limits and a per-service ports panel (IPv6 default-deny); per-client limits in
  HAProxy (Stage B has a 5,000 connection ceiling and 500 per site).
- Stage G: dedicated IPv4 add-on (monthly). Touches billing: designed in test mode first, then your
  approval, and the questions for Razorpay in writing. Until it's live, every new service keeps a
  dedicated IPv4 included and nobody can untick it. Coolify plans keep it included until a Traefik
  panel URL is proven; existing Floating IP customers keep theirs included.

**2. DNS**
- Stage D: DNS subzone client (`c.sowsicloud.com`, from Hetzner's current official API) and
  records per service (`name.c.sowsicloud.com`).
- Stage E: domain claims, Add Domain, Verify DNS, background checks.

**3. Dynamic allocation** — stages to agree.

**4. Stage 3** — wire node purchase (install-node.ts) to engine approval.

**Housekeeping**
- eslint reports 2 errors and 1 warning in files no stage has touched: `dashboard/profile/page.tsx`
  (setState inside an effect), `components/ui/Toast.tsx` (reassigns an outer variable) and an unused
  `monthlyPayments` in `admin/page.tsx`. The build passes; fix before launch.

**Launch blockers (don't forget)**
- Pricing decision.
- The paid client: Dedicated Business, next charge 29 Nov 2026, has no server.
- Billing cron running on sowsi-mgmt-01.
- Razorpay live webhook check.
- Alert emails through Microsoft mail. Seen failing on 12 Nov 2026: at the end of the sowsi-test-07
  install, "[admin-alert] failed: New Proxmox node installed: sowsi-test-07 Error: Microsoft sendMail
  failed (502): UnknownError" (src/lib/mailer.ts). The sign-in worked (its failure reads differently);
  Graph's sendMail itself answered 502. Not fixed yet. `scripts/prod/mail-check.ts` (read only, sends
  nothing) shows the token's permissions, the sender user and its mailbox. To do: log Graph's
  request-id on a failed send (Microsoft support asks for it) and decide on a retry for 5xx.
- GST and GSTIN.
- A small live order and refund test.
- Coolify tested inside a container.
- Terms reviewed.
