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

## In progress

**1. Shared IPv4 gateway — Stage A: private IPv4 per service and NAT.**
Built and tested locally; waiting for the throwaway-node test.

## Pending

**1. Shared IPv4 gateway** (design: "Shared IPv4 Gateway Design", with your answers of 11 Nov 2026)
- Stage B: gateway container (VM 9000, HAProxy, its own Floating IP), `sowsi-gateway sync`,
  dispatcher command, injection tests, installer step.
- Stage C: shared mode in provisioning behind a per-node flag, one connection helper, labels
  everywhere an IP is shown.
- Stage F: abuse limits and a per-service ports panel (IPv6 default-deny).
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
- Alert emails through Microsoft mail.
- GST and GSTIN.
- A small live order and refund test.
- Coolify tested inside a container.
- Terms reviewed.
