export type ServiceStatus =
  | "PENDING"
  | "PROVISIONING"
  | "INSTALLING"
  | "ACTIVE"
  | "SUSPENDED"
  | "CANCELLED"
  | "FAILED"
  | "DELETED";

type Tone = "success" | "progress" | "warning" | "danger" | "neutral";

/** Label + tone for each service status (DESIGN.md §7 "Status badge"). */
export const SERVICE_STATUS: Record<ServiceStatus, { label: string; tone: Tone }> = {
  PENDING: { label: "Setting up", tone: "progress" },
  PROVISIONING: { label: "Setting up", tone: "progress" },
  INSTALLING: { label: "Setting up", tone: "progress" },
  ACTIVE: { label: "Running", tone: "success" },
  SUSPENDED: { label: "Suspended", tone: "warning" },
  FAILED: { label: "Setup failed", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  DELETED: { label: "Deleted", tone: "neutral" },
};

const toneClass: Record<Tone, { badge: string; dot: string }> = {
  success: { badge: "bg-success/10 border-success/30 text-success", dot: "bg-success" },
  progress: { badge: "bg-link/10 border-link/30 text-link", dot: "bg-link animate-pulse" },
  warning: { badge: "bg-warning/10 border-warning/30 text-warning", dot: "bg-warning" },
  danger: { badge: "bg-danger/10 border-danger/30 text-danger", dot: "bg-danger" },
  neutral: { badge: "bg-surface-2 border-line-strong text-fg-muted", dot: "bg-fg-subtle" },
};

export function StatusBadge({ status }: { status: ServiceStatus }) {
  const { label, tone } = SERVICE_STATUS[status];
  const cls = toneClass[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${cls.badge}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${cls.dot}`} aria-hidden />
      {label}
    </span>
  );
}
