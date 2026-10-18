import Link from "next/link";

const STEPS = ["Plan", "Configure", "Pay", "Deploy"] as const;
export type OrderStep = (typeof STEPS)[number];

/**
 * Progress through the deploy flow (DESIGN.md §7 "Stepper"). Completed steps
 * link back when an href is given; later steps are plain text.
 */
export function OrderSteps({
  current,
  hrefs = {},
}: {
  current: OrderStep;
  hrefs?: Partial<Record<OrderStep, string>>;
}) {
  const currentIndex = STEPS.indexOf(current);

  return (
    <nav aria-label="Order progress" className="mb-8">
      <p className="sm:hidden text-xs font-medium text-fg-muted">
        Step {currentIndex + 1} of {STEPS.length} · <span className="text-fg">{current}</span>
      </p>
      <ol className="hidden sm:flex items-center gap-2 text-sm">
        {STEPS.map((step, i) => {
          const done = i < currentIndex;
          const isCurrent = i === currentIndex;
          const href = done ? hrefs[step] : undefined;
          const marker = (
            <span
              className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold border transition-colors duration-200 ${
                done
                  ? "bg-success/10 border-success/40 text-success"
                  : isCurrent
                  ? "bg-primary border-primary text-on-primary ring-4 ring-primary/25"
                  : "border-line-strong text-fg-muted"
              }`}
              aria-hidden
            >
              {done ? (
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                i + 1
              )}
            </span>
          );
          const label = (
            <span className={isCurrent ? "text-fg font-semibold" : "text-fg-muted group-hover:text-fg transition-colors"}>
              {step}
              {done && <span className="sr-only"> (completed)</span>}
            </span>
          );
          return (
            <li key={step} className="flex items-center gap-2" aria-current={isCurrent ? "step" : undefined}>
              {href ? (
                <Link href={href} className="group flex items-center gap-2 rounded-md">
                  {marker}
                  {label}
                </Link>
              ) : (
                <span className="flex items-center gap-2">
                  {marker}
                  {label}
                </span>
              )}
              {i < STEPS.length - 1 && <span className="w-8 h-px bg-line-strong mx-1" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
