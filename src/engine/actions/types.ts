// Shared types for engine actions.

/** The container an action works on. */
export type ContainerTarget = {
  node: { id: string; name: string; ip: string };
  vmid: number;
  /** Null for a container without a service (e.g. a test container): nothing is written to Service. */
  serviceId: string | null;
  planRamMB: number;
  planDiskGB: number;
};

/** One row for the EngineLog audit trail. */
export type EngineLogEntry = {
  action: string;
  serviceId?: string | null;
  vmid?: number;
  fromNode?: string;
  toNode?: string;
  before?: unknown;
  after?: unknown;
  /** Monthly cost attributed to this action, in paise. */
  cost?: number;
  trigger: "AUTO_ENGINE" | "MANUAL" | "SCHEDULED";
  /** Planned/logged only — nothing was changed. */
  dryRun?: boolean;
  success?: boolean;
  error?: string;
};

export type EngineLogWriter = (entry: EngineLogEntry) => Promise<void>;

/** Why a plan can't go ahead, plus what would unblock it (for the DecisionMaker). */
export type Blocked = {
  ok: false;
  reason: string;
  /** Machine-readable cause. */
  code: string;
  /** Follow-up action that would make this possible, if any. */
  next?: { kind: "VOLUME_PURCHASE" | "UPGRADE_PLAN" | "NOTIFY_CLIENT"; detail: string; monthlyCostPaise?: number };
};
