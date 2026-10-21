import type { Decision, DecisionPayload } from "./decisions";
import { gate, type ActionKind, type EngineSettings, type Gate } from "./policy";
import type { EngineLogWriter } from "../actions/types";
import type { Approval } from "../actions/VolumeManager";
import { createLogger, type Logger } from "../log";

/** How long an approval request stays open. No answer → nothing happens. */
export const APPROVAL_TTL_MS = 2 * 60 * 60 * 1000;

export type HandlerContext = { trigger: "AUTO_ENGINE" | "MANUAL"; approval?: Approval };

/** Carries out one kind of decision (re-planning against current state first). Returns a one-line result. */
export type ActionHandler = (payload: DecisionPayload, ctx: HandlerContext) => Promise<string>;

export type ApprovalRecord = {
  id: string;
  kind: string;
  subject: string;
  summary: string;
  payload: DecisionPayload;
  monthlyCostPaise: number;
  /** The request already said it would go over the spend cap, so the approver accepted that. */
  overCapAtRequest: boolean;
  decidedBy: string | null;
};

export type ApprovalStore = {
  /** A PENDING (or APPROVED but not yet run) request for the same kind + subject. */
  findOpen(kind: ActionKind, subject: string): Promise<{ id: string } | null>;
  create(data: { decision: Decision; expiresAt: Date; overCap: boolean }): Promise<{ id: string }>;
  /** Marks overdue PENDING requests EXPIRED; returns them. */
  expireDue(now: Date): Promise<{ id: string; summary: string }[]>;
  /** Atomically claims APPROVED requests that haven't run yet (so two executors can't both run one). */
  claimApproved(): Promise<ApprovalRecord[]>;
  finish(id: string, status: "EXECUTED" | "FAILED", result: string): Promise<void>;
};

export type ExecutorDeps = {
  settings(): EngineSettings;
  spentThisMonthPaise(): Promise<number>;
  handlers: Partial<Record<ActionKind, ActionHandler>>;
  approvals: ApprovalStore;
  alertAdmin(title: string, detail: string): Promise<void>;
  log: EngineLogWriter;
  /** How an admin approves, shown in the approval email. */
  approveHint(approvalId: string): string;
};

export type ExecutionOutcome = { verdict: Gate["verdict"]; reason: string; result?: string; approvalId?: string };

/**
 * Applies the policy gate to each decision and does exactly what it allows:
 * log only, block, recommend, request approval, or execute. Also runs
 * approved requests and expires unanswered ones.
 */
export class ActionExecutor {
  private readonly log: Logger;

  constructor(
    private readonly deps: ExecutorDeps,
    options: { log?: Logger; now?: () => number } = {}
  ) {
    this.log = options.log ?? createLogger("executor");
    this.now = options.now ?? Date.now;
  }

  private readonly now: () => number;

  async handle(decision: Decision): Promise<ExecutionOutcome> {
    const settings = this.deps.settings();
    // Every action that adds monthly cost is checked against this month's spend.
    const spent = decision.monthlyCostPaise > 0 ? await this.deps.spentThisMonthPaise() : 0;
    const overCap = decision.monthlyCostPaise > 0 && spent + decision.monthlyCostPaise > settings.spendCapPaise;
    let g = gate({ kind: decision.kind, settings, monthlyCostPaise: decision.monthlyCostPaise, spentThisMonthPaise: spent, trigger: "AUTO_ENGINE" });

    const handler = this.deps.handlers[decision.kind];
    if (!handler && (g.verdict === "EXECUTE" || g.verdict === "REQUEST_APPROVAL")) {
      g = { verdict: "RECOMMEND", reason: `${decision.kind} isn't automated yet — ${g.reason}` };
    }
    // Asking an admin to approve emailing the admins is just a worse admin alert.
    if (decision.kind === "ALERT_ADMIN" && g.verdict === "REQUEST_APPROVAL") {
      g = { verdict: "RECOMMEND", reason: `${g.reason}; sent as a plain alert` };
    }

    const outcome = await this.apply(decision, g, handler, overCap);
    await this.deps.log({
      action: `DECISION_${decision.kind}`,
      serviceId: decision.subject.startsWith("service:") ? decision.subject.slice(8) : null,
      fromNode: "nodeName" in decision.payload ? decision.payload.nodeName : undefined,
      after: { summary: decision.summary, reason: decision.reason, verdict: outcome.verdict, why: outcome.reason, result: outcome.result, approvalId: outcome.approvalId },
      cost: decision.monthlyCostPaise,
      trigger: "AUTO_ENGINE",
      // Only EXECUTE changes anything.
      dryRun: outcome.verdict !== "EXECUTE",
      success: outcome.verdict !== "EXECUTE" || !outcome.result?.startsWith("failed"),
    });
    return outcome;
  }

  private async apply(decision: Decision, g: Gate, handler: ActionHandler | undefined, overCap: boolean): Promise<ExecutionOutcome> {
    switch (g.verdict) {
      case "LOG_ONLY":
      case "BLOCKED":
        return { verdict: g.verdict, reason: g.reason };

      case "RECOMMEND": {
        const p = decision.payload;
        const [title, detail] =
          p.kind === "ALERT_ADMIN" ? [p.title, p.detail] : [`Engine recommends: ${decision.summary}`, `${decision.reason}\n\nNot done automatically: ${g.reason}.`];
        await this.deps.alertAdmin(title, detail).catch((e) => this.log.error("admin alert failed:", e));
        return { verdict: "RECOMMEND", reason: g.reason };
      }

      case "REQUEST_APPROVAL": {
        const open = await this.deps.approvals.findOpen(decision.kind, decision.subject);
        if (open) return { verdict: "REQUEST_APPROVAL", reason: `${g.reason} (already waiting: ${open.id})`, approvalId: open.id };
        const expiresAt = new Date(this.now() + APPROVAL_TTL_MS);
        const { id } = await this.deps.approvals.create({ decision, expiresAt, overCap });
        await this.deps
          .alertAdmin(
            `Approval needed: ${decision.summary}`,
            [
              decision.reason,
              `Why approval: ${g.reason}.`,
              decision.monthlyCostPaise ? `New monthly cost: ${rupees(decision.monthlyCostPaise)}` : "No extra cost.",
              `Expires: ${expiresAt.toISOString()} (2 hours). If nobody answers, nothing happens.`,
              "",
              this.deps.approveHint(id),
            ].join("\n")
          )
          .catch((e) => this.log.error("approval email failed:", e));
        return { verdict: "REQUEST_APPROVAL", reason: g.reason, approvalId: id };
      }

      case "EXECUTE": {
        try {
          const result = await handler!(decision.payload, { trigger: "AUTO_ENGINE" });
          return { verdict: "EXECUTE", reason: g.reason, result };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.error(`${decision.kind} failed: ${message}`);
          return { verdict: "EXECUTE", reason: g.reason, result: `failed: ${message}` };
        }
      }
    }
  }

  /** Expires unanswered requests and runs approved ones (re-planned against current state). */
  async processApprovals(): Promise<{ expired: number; executed: number; failed: number }> {
    const expired = await this.deps.approvals.expireDue(new Date(this.now()));
    for (const e of expired) {
      await this.deps.log({ action: "APPROVAL_EXPIRED", after: { approvalId: e.id, summary: e.summary }, trigger: "AUTO_ENGINE", dryRun: true });
    }

    let executed = 0;
    let failed = 0;
    for (const req of await this.deps.approvals.claimApproved()) {
      const handler = this.deps.handlers[req.kind as ActionKind];
      // OFF still wins over an approval (e.g. an action switched off after it was approved).
      const settings = this.deps.settings();
      if (!handler || settings.actions[req.kind as ActionKind] === "OFF") {
        await this.deps.approvals.finish(req.id, "FAILED", handler ? `${req.kind} is switched off` : `${req.kind} isn't automated yet`);
        failed++;
        continue;
      }
      // Spend may have grown since the request; the approver only accepted going over the cap if the request said so.
      if (req.monthlyCostPaise > 0 && !req.overCapAtRequest) {
        const spent = await this.deps.spentThisMonthPaise();
        if (spent + req.monthlyCostPaise > settings.spendCapPaise) {
          const why = `this month's engine spend is now ${rupees(spent)}; adding ${rupees(req.monthlyCostPaise)} goes over the ${rupees(settings.spendCapPaise)} cap — not run, the engine will ask again`;
          await this.deps.approvals.finish(req.id, "FAILED", why);
          await this.deps.log({ action: `APPROVED_${req.kind}`, after: { approvalId: req.id, summary: req.summary }, cost: 0, trigger: "MANUAL", success: false, error: why });
          failed++;
          continue;
        }
      }
      try {
        const result = await handler(req.payload, { trigger: "MANUAL", approval: { approvedBy: req.decidedBy ?? "admin", approvalId: req.id } });
        await this.deps.approvals.finish(req.id, "EXECUTED", result);
        await this.deps.log({ action: `APPROVED_${req.kind}`, after: { approvalId: req.id, approvedBy: req.decidedBy, summary: req.summary, result }, trigger: "MANUAL" });
        executed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.deps.approvals.finish(req.id, "FAILED", message);
        await this.deps.log({ action: `APPROVED_${req.kind}`, after: { approvalId: req.id, approvedBy: req.decidedBy, summary: req.summary }, trigger: "MANUAL", success: false, error: message });
        failed++;
      }
    }
    return { expired: expired.length, executed, failed };
  }
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;
