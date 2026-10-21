// Who may do what. Every engine action passes through gate() before it runs.
//
// Agreed rules (see DESIGN notes in the engine docs):
//   - Global mode OBSERVE (default) → log only, whatever the action's setting.
//   - Otherwise the stricter of the global mode and the action's mode applies.
//   - An action set to OFF never runs, not even when an admin asks.
//   - Anything that would push this month's engine spend over the cap needs approval.
//   - An admin-triggered (or admin-approved) action counts as approved.

export type EngineMode = "OBSERVE" | "ASSISTED" | "AUTO";

/**
 * AUTO     → run immediately
 * ASSISTED → email admin with approve/deny; run on approval
 * MANUAL   → only recommend (admin alert); a human starts it from the dashboard
 * OFF      → never
 */
export type ActionMode = "AUTO" | "ASSISTED" | "MANUAL" | "OFF";

export type ActionKind =
  | "RAM_SCALE"
  | "DISK_EXPAND"
  | "VOLUME_PURCHASE"
  | "SERVER_PURCHASE"
  | "MIGRATION"
  | "OVERAGE_BILLING";

export const DEFAULT_ACTION_MODES: Record<ActionKind, ActionMode> = {
  RAM_SCALE: "AUTO", // instant, no cost
  DISK_EXPAND: "ASSISTED", // low cost
  VOLUME_PURCHASE: "MANUAL", // ₹530/month
  SERVER_PURCHASE: "MANUAL", // ₹3,300/month
  MIGRATION: "ASSISTED", // causes downtime
  OVERAGE_BILLING: "OFF", // client must opt in
};

export const DEFAULT_SPEND_CAP_PAISE = 500_000; // ₹5,000 / month

export type EngineSettings = {
  mode: EngineMode;
  actions: Record<ActionKind, ActionMode>;
  /** New monthly infrastructure cost the engine may commit to on its own, per calendar month. */
  spendCapPaise: number;
};

export type Gate =
  | { verdict: "EXECUTE"; reason: string }
  | { verdict: "REQUEST_APPROVAL"; reason: string }
  | { verdict: "RECOMMEND"; reason: string }
  | { verdict: "LOG_ONLY"; reason: string }
  | { verdict: "BLOCKED"; reason: string };

export type GateInput = {
  kind: ActionKind;
  settings: EngineSettings;
  /** Monthly cost this action adds, in paise (0 for free actions). */
  monthlyCostPaise: number;
  /** Monthly cost already committed by the engine this calendar month, in paise. */
  spentThisMonthPaise: number;
  /** AUTO_ENGINE = the engine's own decision; MANUAL = an admin started or approved it. */
  trigger: "AUTO_ENGINE" | "MANUAL";
};

const STRICTNESS: Record<ActionMode, number> = { AUTO: 0, ASSISTED: 1, MANUAL: 2, OFF: 3 };
const GLOBAL_AS_ACTION: Record<Exclude<EngineMode, "OBSERVE">, ActionMode> = { AUTO: "AUTO", ASSISTED: "ASSISTED" };

/** The stricter of two action modes. */
export function stricter(a: ActionMode, b: ActionMode): ActionMode {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

export function gate({ kind, settings, monthlyCostPaise, spentThisMonthPaise, trigger }: GateInput): Gate {
  const actionMode = settings.actions[kind];
  if (actionMode === "OFF") return { verdict: "BLOCKED", reason: `${kind} is switched off` };

  // A human started or approved it: run it (OFF already handled above).
  if (trigger === "MANUAL") return { verdict: "EXECUTE", reason: "started or approved by an admin" };

  if (settings.mode === "OBSERVE") return { verdict: "LOG_ONLY", reason: "engine is in OBSERVE mode" };

  if (monthlyCostPaise > 0 && spentThisMonthPaise + monthlyCostPaise > settings.spendCapPaise) {
    return {
      verdict: "REQUEST_APPROVAL",
      reason: `would take this month's engine spend to ${rupees(spentThisMonthPaise + monthlyCostPaise)}, over the ${rupees(settings.spendCapPaise)} cap`,
    };
  }

  const effective = stricter(GLOBAL_AS_ACTION[settings.mode], actionMode);
  const why = effective === actionMode ? `${kind} is set to ${actionMode}` : `engine is in ${settings.mode} mode`;
  switch (effective) {
    case "AUTO":
      return { verdict: "EXECUTE", reason: why };
    case "ASSISTED":
      return { verdict: "REQUEST_APPROVAL", reason: why };
    case "MANUAL":
      return { verdict: "RECOMMEND", reason: why };
    default:
      return { verdict: "BLOCKED", reason: why };
  }
}

// ── Settings from the environment (admin dashboard switches replace this later) ──

const ENGINE_MODES = new Set<string>(["OBSERVE", "ASSISTED", "AUTO"]);
const ACTION_MODES = new Set<string>(["AUTO", "ASSISTED", "MANUAL", "OFF"]);

/**
 * ENGINE_MODE=OBSERVE|ASSISTED|AUTO                 [OBSERVE]
 * ENGINE_ACTION_<KIND>=AUTO|ASSISTED|MANUAL|OFF      [see DEFAULT_ACTION_MODES]
 * ENGINE_SPEND_CAP_PAISE                             [500000]
 */
export function loadEngineSettings(env: Record<string, string | undefined> = process.env): EngineSettings {
  const mode = (env.ENGINE_MODE ?? "OBSERVE").trim().toUpperCase();
  if (!ENGINE_MODES.has(mode)) throw new Error(`ENGINE_MODE must be OBSERVE, ASSISTED or AUTO, got "${env.ENGINE_MODE}"`);

  const actions = { ...DEFAULT_ACTION_MODES };
  for (const kind of Object.keys(DEFAULT_ACTION_MODES) as ActionKind[]) {
    const raw = env[`ENGINE_ACTION_${kind}`]?.trim().toUpperCase();
    if (!raw) continue;
    if (!ACTION_MODES.has(raw)) throw new Error(`ENGINE_ACTION_${kind} must be AUTO, ASSISTED, MANUAL or OFF, got "${raw}"`);
    actions[kind] = raw as ActionMode;
  }

  const capRaw = env.ENGINE_SPEND_CAP_PAISE?.split("#")[0].trim();
  const spendCapPaise = capRaw ? Number(capRaw) : DEFAULT_SPEND_CAP_PAISE;
  if (!Number.isInteger(spendCapPaise) || spendCapPaise < 0) {
    throw new Error(`ENGINE_SPEND_CAP_PAISE must be a whole number of paise, got "${env.ENGINE_SPEND_CAP_PAISE}"`);
  }

  return { mode: mode as EngineMode, actions, spendCapPaise };
}
