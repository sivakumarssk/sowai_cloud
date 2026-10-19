import { type PriceQuote, CYCLES, formatINR } from "@/lib/pricing";

/**
 * Price breakdown shown on every step of the deploy flow (DESIGN.md §9).
 * Always shows what's due today and what autopay charges afterwards.
 */
export function OrderSummary({
  planName,
  quote,
  children,
}: {
  planName: string;
  quote: PriceQuote;
  children?: React.ReactNode;
}) {
  const { months } = quote;
  const r = quote.renewal;

  return (
    <div className="rounded-xl bg-surface border border-line p-5 sm:p-6">
      <h2 className="text-fg font-semibold text-lg mb-4">Order summary</h2>

      <dl className="text-sm">
        <div className="flex items-start justify-between gap-3 pb-3">
          <dt>
            <span className="block text-fg font-medium">
              {planName} · {CYCLES[quote.cycle].label}
            </span>
            <span className="block text-xs text-fg-muted mt-0.5 tabular-nums">
              {formatINR(quote.planRate)}/mo × {months} {months === 1 ? "month" : "months"}
            </span>
          </dt>
          <dd className="text-fg font-medium tabular-nums shrink-0">{formatINR(quote.planTotal)}</dd>
        </div>

        {quote.addons.map((a) => (
          <div key={a.slug} className="flex items-start justify-between gap-3 py-3 border-t border-line">
            <dt>
              <span className="block text-fg">{a.name}</span>
              <span className="block text-xs text-fg-muted mt-0.5 tabular-nums">
                {formatINR(a.rate)}/mo × {months}
              </span>
            </dt>
            <dd className="text-fg tabular-nums shrink-0">{formatINR(a.total)}</dd>
          </div>
        ))}

        <div className="border-t border-line pt-3 flex flex-col gap-2">
          <div className="flex justify-between">
            <dt className="text-fg-muted">Subtotal</dt>
            <dd className="text-fg tabular-nums">{formatINR(quote.subtotal)}</dd>
          </div>
          {/* Payment fee + GST, shown as one line */}
          <div className="flex justify-between">
            <dt className="text-fg-muted">Charges</dt>
            <dd className="text-fg tabular-nums">{formatINR(quote.processingFee + quote.gst)}</dd>
          </div>
        </div>

        <div className="border-t border-line mt-3 pt-3 flex items-baseline justify-between">
          <dt className="text-fg font-semibold">Due today</dt>
          <dd className="text-link font-bold text-2xl tabular-nums">{formatINR(quote.total)}</dd>
        </div>
      </dl>

      <p className="text-xs text-fg-muted mt-4 rounded-lg bg-canvas px-3 py-2.5">
        Autopay renews at <span className="text-fg tabular-nums">{formatINR(r.monthlySubtotal)}/mo</span>
        {quote.cycle !== "monthly" && ` after ${months} months`}. Cancel anytime.
      </p>

      {children}
    </div>
  );
}

/** Small trust line under the main CTA. */
export function PaymentNote() {
  return (
    <p className="flex items-center justify-center gap-1.5 text-xs font-medium text-success mt-3">
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
        />
      </svg>
      Secure &amp; trusted payments
    </p>
  );
}

/** Phone-only sticky bar so the total and next step are always in reach. */
export function MobileOrderBar({ total, children }: { total: number; children: React.ReactNode }) {
  return (
    <div className="lg:hidden fixed inset-x-0 bottom-0 z-40 bg-surface border-t border-line px-4 py-3 flex items-center gap-4">
      <div className="min-w-0">
        <p className="text-xs text-fg-muted">Due today</p>
        <p className="text-link font-bold text-lg tabular-nums leading-tight">{formatINR(total)}</p>
      </div>
      <div className="flex-1 flex justify-end">{children}</div>
    </div>
  );
}
