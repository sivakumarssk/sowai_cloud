# Sowsi Cloud — Design System

The single source of truth for how Sowsi Cloud looks and behaves. Every new page
or component follows this file; when code and this file disagree, fix one of
them in the same change.

**Product:** VPS and object-storage hosting for developers and businesses in India.
**Users:** developers who live in terminals, and small-business owners who need
to trust that the bill is correct. Both are on laptops at work and on phones on
the move.
**Feel:** a precise, quiet infrastructure console. Dense where it helps (server
lists, specs), calm everywhere else. Nothing decorative competes with the data.

> Generated with the UI/UX Pro Max skill (`--design-system`, query
> "developer infrastructure cloud console dark", variance 3 · motion 3 · density 7),
> which resolved to **Minimalism & Swiss Style** with a "code dark + run green"
> palette and an IBM Plex Sans / JetBrains Mono pairing. Adapted to use an
> electric-blue brand accent close to the Sowsi logo blue. A first run with generic "SaaS hosting"
> terms suggested light glassmorphism; it was rejected because the product is
> already dark, its audience is developers, and blur/glass hurts the contrast
> and density a console needs.

---

## 1. Principles

1. **Data first.** IPs, hostnames, specs and prices are the content. Give them the
   strongest contrast and a monospace face; keep chrome muted.
2. **Say what it costs, every time.** Show the amount due today *and* what renews
   later, in rupees, from the same pricing functions the server uses. No number
   on screen may differ from what Razorpay charges.
3. **Status is never colour alone.** Every state has a dot *and* a word (and an
   icon where space allows).
4. **One accent, used on purpose.** Electric blue marks "this is the next step"
   and "this is what you picked". Everything else stays neutral, so the accent
   is easy to spot. See §2.1.
5. **Don't move the user without asking.** No auto-redirects, no surprise modals,
   no layout shifts while data loads.

---

## 2. Colour

Dark mode is the only mode. Tokens live in `src/app/globals.css` (`@theme`) and
are available as Tailwind classes, e.g. `bg-surface`, `text-fg-muted`, `border-line`.
Never write raw hex in components for these roles.

| Token | Hex | Tailwind | Use |
|---|---|---|---|
| `canvas` | `#0B1120` | `bg-canvas` | Page background, inset "wells" inside cards |
| `surface` | `#111827` | `bg-surface` | Cards, sidebar, navbar, table rows |
| `surface-2` | `#1F2937` | `bg-surface-2` | Hover rows, selected segment, tooltips |
| `line` | `#1F2937` | `border-line` | Default 1px borders and dividers |
| `line-strong` | `#374151` | `border-line-strong` | Inputs, hovered cards, secondary buttons |
| `fg` | `#F8FAFC` | `text-fg` | Headings, primary text, data values |
| `fg-muted` | `#9CA3AF` | `text-fg-muted` | Labels, helper text, secondary copy (6.7:1 on surface) |
| `fg-subtle` | `#6B7280` | `text-fg-subtle` | Placeholders and disabled text **only** (fails 4.5:1 for body text) |
| `primary` | `#2563EB` | `bg-primary` | **Brand accent** (electric blue) fill: see §2.1. White text 5.2:1 |
| `primary-hover` | `#1D4ED8` | `hover:bg-primary-hover` | Accent fill on hover |
| `primary-active` | `#1E40AF` | `active:bg-primary-active` | Accent fill while pressed |
| `on-primary` | `#FFFFFF` | `text-on-primary` | Text/icons on an accent fill (use instead of `text-white`) |
| `link` | `#60A5FA` | `text-link` | The accent as **text** on dark: links, key amounts, icons (6.9:1) |
| `focus` | `#60A5FA` | `outline-focus` | Focus outline |
| `success` | `#34D399` | `text-success` | Running, paid, included |
| `warning` | `#FBBF24` | `text-warning` | Suspended, action needed soon |
| `danger` | `#F87171` | `text-danger` | Failed, errors (text) |
| `danger-fill` | `#DC2626` | `bg-danger-fill` | Destructive button fill |

**Tinted backgrounds** for status and callouts use the semantic colour at low
alpha: `bg-success/10 border-success/30 text-success` (same for warning, danger,
link). Never put muted grey text on a tinted background.

**Do not:** use `text-primary` on dark backgrounds (3.4:1, too dim for text; use
`text-link`). Don't use gradients on buttons or badges, or `text-white` / `text-gray-*`
/ hex classes in components. Every colour comes from a token.

### 2.1 Accent usage

There is exactly one brand accent: **electric blue** (`primary`). It appears only
in these places, so it always means "next step" or "your choice":

| Element | Recipe |
|---|---|
| Primary button | `bg-primary text-on-primary shadow-sm shadow-primary/30`, hover `bg-primary-hover`, pressed `bg-primary-active` + `translate-y-px` (`<Button>` does this) |
| Selected card | `border-primary ring-1 ring-primary bg-primary/10` + filled `RadioDot` (`selectCardClass(true)`) |
| Radio, checked | Filled `bg-primary border-primary` with a white centre dot |
| Switch, on | Track `bg-primary`, white knob (`<Toggle on />`) |
| Active stepper step | `bg-primary text-on-primary ring-4 ring-primary/25` |
| Active segment (billing cycle, tabs) | `bg-primary text-on-primary` |
| Key amount ("Due today") | `text-link font-bold` |
| Links | `text-link hover:underline` |

**Dedicated tier uses gold (`premium`, `#E2B254`), never as an action colour:**
the "Dedicated" badge, the dedicated card border (`border-premium/40`, popular:
`border-premium ring-1 ring-premium`) and its check icons. Buttons, links,
tabs and selection on dedicated cards stay `primary`. Gold on `surface` is 9:1.

**Savings and success use green, never the accent:** "Save 57%" is a pill
`<SavePill percent={57} />` → `rounded-full border border-success/30 bg-success/15 text-success text-xs font-semibold`.

**Text hierarchy:** primary text `text-fg`; anything secondary (descriptions,
"Billed monthly", "/mo", helper text, labels) is `text-fg-muted`. Never leave
secondary copy at full white.

### 2.2 Wiring check

Tokens are defined with Tailwind v4 `@theme` in `globals.css`. There is no
`tailwind.config.js`: `@theme` *is* the config. If token classes such as `bg-primary`
render with no colour, the CSS wasn't rebuilt. Turbopack's dev filesystem cache
used to serve a stale stylesheet even after restarts, so it's turned off in
`next.config.ts` (`turbopackFileSystemCacheForDev: false`). If it happens anyway:
stop `next dev`, delete `.next/`, start again. Don't change components to work
around it.

---

## 3. Typography

| Role | Family | Loaded as |
|---|---|---|
| UI / body / headings | **IBM Plex Sans** 400 · 500 · 600 · 700 | `next/font/google` → `--font-sans` → `font-sans` (default) |
| Data | **JetBrains Mono** 400 · 500 | `next/font/google` → `--font-mono` → `font-mono` |

Use `font-mono` for anything a user might copy or compare character by character:
IP addresses, hostnames, usernames, SSH commands, invoice numbers, spec numbers
in comparison tables. Prices stay in the sans face with `tabular-nums`.

| Style | Classes | Use |
|---|---|---|
| Display | `text-3xl sm:text-4xl font-bold tracking-tight` | Marketing page H1 (one per page) |
| Page title | `text-2xl font-semibold` | Dashboard / flow page H1 |
| Section | `text-lg font-semibold` | Card and section headings |
| Body | `text-sm` (14px) / `text-base` (16px) on marketing | Default copy, line-height ≥ 1.5 |
| Label | `text-xs font-medium text-fg-muted` | Field labels, table headers (sentence case, no all-caps blocks) |
| Data | `font-mono text-sm` | IPs, hostnames, commands |
| Price | `text-4xl font-bold tabular-nums` | Plan card price |

Max weight is 700 (Plex has no 800/900 — don't use `font-black`). Body text never
below 12px; 12px only for labels and footnotes.

---

## 4. Space, radius, elevation

* **Spacing:** 4px base. Use Tailwind steps 1, 2, 3, 4, 5, 6, 8, 10, 12, 16.
  Card padding `p-5` (dense lists) or `p-6`. Gap between cards `gap-4`;
  between page sections `gap-8` (app) / `py-16` (marketing).
* **Radius:** `rounded-lg` (8px) for controls, inputs, badges' containers and
  inset wells; `rounded-xl` (12px) for cards; `rounded-full` for status dots and pills.
* **Elevation:** flat. Separate layers with `border-line` and the canvas/surface
  step. Shadows only on overlays (menus, toasts): `shadow-xl shadow-black/40`.
  No glows, no glass blur.
* **Layout widths:** app content `max-w-6xl`; marketing `max-w-6xl` (plans) /
  `max-w-3xl` (FAQ, prose); flow pages `max-w-5xl` with a 2/3 + 1/3 summary column.
* **Breakpoints:** mobile-first; verify at 375, 768, 1024, 1440. No horizontal
  page scroll — wide tables go in an `overflow-x-auto` wrapper.

---

## 5. Motion

* Button hover/press: 150ms (`<Button>` uses `transition-[background-color,border-color,color,box-shadow,transform] duration-150`).
* Card hover and selection: 200ms `ease-out` on `border-color, background-color, box-shadow`
  (built into `selectCardClass`). Show selection with `ring-1`, never by changing
  border width, which shifts the layout.
* Switch knob and radio dot: 200ms `ease-out` (transform + colour).
* Other colour/border/opacity changes: `transition-colors duration-150`.
* Expanding panels and progress: 200–300ms `ease-out`. Never animate width/height
  of layout boxes except progress bars.
* No hover scale, no bouncing, no parallax. The only "physical" cue is a 1px
  press (`active:translate-y-px`) on buttons.
* The only looping animation is the "setting up" pulse/spinner.
* `prefers-reduced-motion: reduce` disables all of the above (handled globally
  in `globals.css`).

---

## 6. Iconography

Inline SVG, Heroicons-outline style: 24-unit viewBox, `stroke-width 1.5`,
`w-5 h-5` (20px) in navigation, `w-4 h-4` inline with text. `aria-hidden` when
next to a text label; `aria-label` on the button when icon-only.
**No emoji as icons** anywhere in the product.

---

## 7. Components

Recipes are Tailwind class strings; shared components live in `src/components/ui/`.

### Buttons (`components/ui/Button.tsx`)
| Variant | Use | Classes |
|---|---|---|
| Primary | The one next step | Solid `bg-primary text-on-primary`, hover `bg-primary-hover`, pressed `bg-primary-active` |
| Secondary | Other actions | `bg-surface border border-line-strong text-fg`, hover `bg-surface-2`, pressed `bg-canvas` |
| Ghost | Low-emphasis (Cancel, Copy) | `text-fg-muted`, hover `text-fg bg-surface-2` |
| Danger | Destructive confirm | `bg-danger-fill text-on-primary`, hover `bg-red-700` |

The main CTA in an order summary ("Continue to configure", "Continue to payment",
"Pay ₹…") is always `<Button size="lg" className="w-full">`: solid accent fill,
full width of the summary card.

Heights: sm 32px, md 40px, lg 48px. Touch targets on mobile ≥ 44px (use `lg` for
the main CTA on phones). Loading state keeps the label width and shows a spinner;
disabled buttons must have a visible reason nearby — **never a silently disabled CTA**.

### Inputs (`components/ui/Input.tsx`)
Visible `<label htmlFor>` above every field (placeholders are examples, not
labels). `bg-canvas border border-line-strong rounded-lg px-3.5 py-2.5 text-sm`.
Helper text below in `text-fg-muted text-xs`; on error swap it for the error in
`text-danger` with `aria-invalid` + `aria-describedby`. Validate on blur, then live
while the user corrects it. Normalise what we can (e.g. lowercase hostnames)
instead of rejecting it.

### Selection cards (`components/ui/selection.tsx`)
For choices with 2–6 options that need a description (billing cycle, server type,
OS). Wrap in `role="radiogroup"` with `aria-label`; each card is a `<button
role="radio" aria-checked>` styled with `selectCardClass(selected)`:

* Unselected: `border-line bg-surface`, hover `border-line-strong bg-surface-2`.
* Selected: `border-primary ring-1 ring-primary bg-primary/10` **plus** a filled
  `<RadioDot checked />`, so selection isn't shown by colour alone.

On/off extras (add-ons) use the same card with `role="switch"` and a `<Toggle on />`
in place of the radio dot. Savings badges inside cards use `<SavePill>`.
Arrow keys are not required when each card is a native `<button>`, but Tab order
must follow visual order.

### Status badge (`components/ui/StatusBadge.tsx`)
Dot + label, `text-xs font-medium px-2 py-0.5 rounded-full border`.

| Service status | Label | Tone |
|---|---|---|
| `ACTIVE` | Running | success |
| `PENDING` `PROVISIONING` `INSTALLING` | Setting up | link (pulsing dot) |
| `SUSPENDED` | Suspended | warning |
| `FAILED` | Setup failed | danger |
| `CANCELLED` `DELETED` | Cancelled / Deleted | neutral (`text-fg-muted`) |

### Copy field (`components/ui/CopyButton.tsx`)
Any value a developer will paste (IP, username, password, `ssh root@…`) gets a
copy button with `aria-label="Copy <thing>"` and a polite live-region
confirmation ("Copied"). Secrets are masked by default with a Show/Hide toggle.

### Cards
`bg-surface border border-line rounded-xl`. Inset wells for key/value data:
`bg-canvas rounded-lg p-3`. Card headers: section title left, one action right.

### Callouts
`rounded-lg border px-4 py-3 text-sm` with tinted tone (see §2). Lead with what
happens and when ("Paid until 12 Nov. Autopay is off, so the server will be
suspended after that."), then the action button on the right (stacked on mobile).

### Stepper (`components/order/OrderSteps.tsx`)
Used across the deploy flow: **Plan → Configure → Pay → Deploy**. Current step:
filled accent circle with a soft ring (`ring-4 ring-primary/25`) and `aria-current="step"`.
Completed steps: green check and a link back. Upcoming steps: outlined and muted.
On mobile show "Step 2 of 4 · Configure".

### Order summary (`components/order/OrderSummary.tsx`)
Line items in `text-fg` with their breakdown ("₹999/mo × 12 months") in
`text-fg-muted`. **Due today** amount in `text-link text-2xl font-bold`, then
the renewal note in a `bg-canvas` well ("Autopay renews at ₹1,999/mo after 12 months. Cancel anytime." — plan + add-ons price, **without** charges), then the full-width primary CTA. On
phones the same amount and CTA sit in a sticky bottom bar (`MobileOrderBar`).

### Toasts
Bottom-right, max 1–2 lines, for confirmations only. Errors that block a task go
inline next to the control, not in a toast.

---

## 8. Content rules

* **Money:** all amounts are stored in paise. Always render with `formatINR()`
  from `src/lib/pricing.ts` — never `amount.toLocaleString()` on a raw value.
  Prices are per month (`₹599/mo`); under the price, plan cards and cycle options
  say how often it's billed, from `CYCLES[cycle].billed`: "Billed monthly",
  "Billed annually", "Billed every 2 years" (no billed totals). The exact amount
  due appears once, in the order summary. On plan cards, discounted prices show the pay-monthly
  price struck through (`<s>`) above the intro price with a green "Save N%" pill;
  the card itself doesn't repeat the renewal rate. Renewal pricing is stated in
  the note under the plan grid, the "Renews at" row of the comparison table, and
  the order summary before payment.
* **Fees & tax:** the payment fee (`PROCESSING_FEE_PERCENT`, 4%) and GST (`GST_PERCENT`, 18%) are shown
  together as **one** line labelled **"Charges"** (`CHARGES_PERCENT`, 22%). No separate GST row or column in
  the UI; only invoices list GST on its own (a tax-invoice requirement). Never say "payment processing".
* **Dates:** `en-IN`, e.g. `17 Oct 2026`. Relative times only for < 7 days.
* **Brevity:** say it once, in the fewest words. Helper text is one short line
  or nothing; don't explain what a heading or button already says. Renewal terms
  appear once per screen (the summary note), not in every section.
* **Trust line:** under payment CTAs use `<PaymentNote />` → shield icon +
  "Secure & trusted payments" in `text-success`. Don't name the gateway in UI copy.
* **Voice:** plain, specific, second person. Buttons are verbs that say what
  happens: "Deploy VPS Pro", "Continue to payment", "Pay ₹7,331 & start server".
* **Location honesty:** say where servers run (currently Nuremberg, Germany).
* **Empty states:** one sentence on what goes here + one primary action.
* **Errors:** what went wrong + what to do next; include IDs a support agent will
  ask for (e.g. Razorpay payment ID).

---

## 9. Page patterns

### Server list (`/dashboard/services`)
Header (title, count, **Deploy server** primary) → status filter tabs with counts
(All · Running · Setting up · Needs attention) + search by hostname/IP →
one row per server: status, hostname (mono), plan + specs, IPv4 with copy, paid-until,
row actions. Rows expand for SSH access, IPv6, billing/autopay. Servers that are
setting up show inline progress and the list refreshes itself until they finish.
Servers needing attention show a callout without expanding.

### Pricing (`/pricing`)
Headline + one-line value prop → product tabs (VPS · Object Storage · Dedicated) → billing
cycle segmented control showing savings → plan cards (popular plan highlighted by
border + label, specs as a 2×2 mono grid, price, CTA) → spec
comparison table → "every plan includes" grid → FAQ (accordion) → custom-plan CTA.

Plans with `isDedicated` never appear on the VPS or Object Storage tabs. They
live only on the **Dedicated** tab (`/pricing?tab=dedicated`), grouped as
"Dedicated VPS" then "Dedicated S4 Storage". It has the same billing-cycle
picker as VPS: monthly is a flat price ("Same price. Always."), and 1 and 2 year
terms show the struck-through monthly price, a green Save pill and "Billed
annually" / "Billed every 2 years". Dedicated term discounts apply to every customer, not only new ones. The VPS and Storage tabs end with a text link to it.

### Deploy flow (`/order/[plan] → configure → checkout → provisioning`)
Stepper on every step. Left column: the step's choices. Right column (sticky on
desktop, bottom bar on mobile): live order summary with due-today and renewal.
Every step can go back without losing choices (state lives in the URL).
Payment errors never invite a second payment without telling the user whether
the first one went through.

---

## 10. Accessibility checklist (every PR)

- [ ] Text contrast ≥ 4.5:1 (use `fg` / `fg-muted`, never `fg-subtle` for content)
- [ ] No `text-white`, `text-gray-*`, `bg-[#…]` or inline `style` colours; tokens only
- [ ] Accent used only for the roles in §2.1
- [ ] Visible focus outline on every interactive element (global `:focus-visible`)
- [ ] Every input has a `<label>`; errors are linked with `aria-describedby`
- [ ] Status shown with text, not colour alone
- [ ] Icon-only buttons have `aria-label`; decorative SVGs have `aria-hidden`
- [ ] Touch targets ≥ 44px on mobile; 8px between adjacent targets
- [ ] Works at 375px with no horizontal scroll
- [ ] `prefers-reduced-motion` respected
- [ ] No emoji icons; `cursor-pointer` on clickable non-button elements
- [ ] Money rendered with `formatINR` and matches what the API charges

## 11. Anti-patterns

Glassmorphism/backdrop blur · gradient buttons and glows · light mode ·
a second accent colour · selection shown by changing border width ·
`font-black` · emoji icons · grey-500 body text · colour-only status ·
disabled buttons with no explanation · auto-redirect timers · placeholder-only
labels · errors only at the top of a form · checkout without renewal terms ·
raw paise shown as rupees.
