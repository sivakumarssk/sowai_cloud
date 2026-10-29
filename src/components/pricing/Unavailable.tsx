import { UNAVAILABLE_LABEL } from "@/lib/provisioning/availability";

/** Stands in for the Buy button of a plan that can't be built right now — with the reason beside it. */
export function UnavailablePlan({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <span className="text-fg-muted text-sm">
        {UNAVAILABLE_LABEL} ·{" "}
        <a href="mailto:sales@sowsicloud.com" className="text-link hover:underline">
          ask sales
        </a>
      </span>
    );
  }
  return (
    <div className="mt-5">
      <p
        role="status"
        className="flex items-center justify-center h-11 rounded-lg text-sm font-semibold bg-surface-2 border border-line text-fg-muted"
      >
        {UNAVAILABLE_LABEL}
      </p>
      <p className="mt-2 text-xs text-fg-muted text-center">
        We&apos;re adding capacity for this size.{" "}
        <a href="mailto:sales@sowsicloud.com" className="text-link hover:underline">
          Email sales
        </a>{" "}
        to reserve one.
      </p>
    </div>
  );
}
