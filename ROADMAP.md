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
- Every service still defaults to a dedicated IPv4; nothing uses shared mode until Stage C.

## In progress

**1. Shared IPv4 gateway — Stage B: the gateway container.** Built and tested locally; waiting
for the throwaway-node test.
- First test (sowsi-test-05, server 175731990, 12 Nov 2026): failed at the gateway step. HAProxy
  started by apt on the package's config, and a reload keeps the config the master started with,
  so ours was never loaded. Fixed: HAProxy is restarted onto our config whenever the running
  process isn't on it (read from its master's command line), and "serving" now requires it. The
  rig now behaves like systemd and reproduces the failure with the old script.
- Also from that test: the card's name pin matched vmbr0 too (same MAC), so udev tried to rename
  the bridge. Fixed with `Type=ether`, as Proxmox's own docs do; the installer now checks after the
  reboot that the pin doesn't apply to vmbr0 and that udev never tried to rename it.
- `sowsi-gateway` refusing a command line now shows what it got (a stray carriage return showed
  only as the usage line).
- `sowsi-gateway` on each node: HAProxy in container 9000 on a Floating IP of its own. Port 80 by
  the Host header, 443 by the TLS name, passed through still encrypted. Unknown name: a neutral 404
  on 80, a closed connection on 443. The client's own X-Forwarded-For is dropped.
- `sync <version>`: the whole table on stdin, every line checked (hostname, 16-character key,
  a shared address of a container on this node, PROXY 0 or 1), size-capped, older versions refused;
  then HAProxy's config test, a graceful reload, proof the new version serves, else back to the
  last good. Dispatcher: `gateway-status`, `gateway-sync <version>`.
- Rules: the gateway reaches shared containers on 80 and 443 only; containers reach it on 80 and
  443 only (a site calling its own domain).
- Installer: a gateway step (its Floating IP under the spend cap, adopted if a run stopped after
  buying it, released with the server on a failed install), step 4 proves two names route to two
  containers from outside, and the node registers with its gateway. The gateway takes no
  customer's slot in `maxContainers`.
- `--destroy` releases every Floating IP the installer labelled; any other on the server stops the
  plan until `--release-floating-ip <id>` or `--keep-floating-ip <id>`.
- isolation-test.sh test 16 prints docker run's own error and retries once; test 28 checks the
  gateway on the node, and again after a reboot.

## Pending

**1. Shared IPv4 gateway** (design: "Shared IPv4 Gateway Design", with your answers of 11 Nov 2026)
- Stage C: shared mode in provisioning behind a per-node flag, one connection helper, labels
  everywhere an IP is shown. The sync job (on every route change and every 5 minutes) sends
  versions above the node's `gatewayRoutesVersion`.
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
- Alert emails through Microsoft mail.
- GST and GSTIN.
- A small live order and refund test.
- Coolify tested inside a container.
- Terms reviewed.
