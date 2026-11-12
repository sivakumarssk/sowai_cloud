import type { ServiceConnection } from "@/lib/provisioning/connection";

/** "Shared" or "Dedicated", next to an IPv4 address. The wording comes from serviceConnection(). */
export function Ipv4Tag({ connection }: { connection: Pick<ServiceConnection, "tag" | "label" | "ipv4Note"> }) {
  return (
    <span
      title={`${connection.label}: ${connection.ipv4Note}`}
      className="inline-flex items-center text-[11px] font-medium px-1.5 py-0.5 rounded-md border whitespace-nowrap bg-surface-2 border-line-strong text-fg-muted"
    >
      {connection.tag}
    </span>
  );
}
