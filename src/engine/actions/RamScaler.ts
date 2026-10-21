import type { EngineConfig } from "../config";
import type { Blocked, ContainerTarget, EngineLogEntry, EngineLogWriter } from "./types";

export type RamScalerDeps = {
  /** Current memory limit from the container config, MB. */
  readMemoryMB(target: ContainerTarget): Promise<number>;
  /** Sets the memory limit; applies to a running container immediately (no restart). */
  writeMemoryMB(target: ContainerTarget, mb: number): Promise<void>;
  /** Remembers the new limit on the Service (managed containers only). */
  recordAllocation(target: ContainerTarget, mb: number): Promise<void>;
  log: EngineLogWriter;
};

export type RamPlan = {
  ok: true;
  kind: "RAM_SCALE";
  target: ContainerTarget;
  beforeMB: number;
  afterMB: number;
  deltaMB: number;
  /** RAM scaling never costs extra infrastructure. */
  monthlyCostPaise: 0;
  /** True when the plan was trimmed to the floor/ceiling. */
  clamped: boolean;
  reason: string;
  summary: string;
};

export type RamRequest = { reason: string } & ({ addMB?: number; toMB?: never } | { toMB: number; addMB?: never });

/**
 * Raises or lowers a container's RAM limit within hard bounds:
 * never below the plan (clients always get what they pay for) and never
 * above plan × RAM_MAX_MULTIPLIER. Free, instant, no restart.
 */
export class RamScaler {
  constructor(
    private readonly deps: RamScalerDeps,
    private readonly config: Pick<EngineConfig, "ramExpandChunkMB" | "ramMaxMultiplier">
  ) {}

  /** Bounds for a target, MB. */
  limits(target: ContainerTarget): { floorMB: number; ceilingMB: number } {
    return { floorMB: target.planRamMB, ceilingMB: Math.floor(target.planRamMB * this.config.ramMaxMultiplier) };
  }

  /** Works out the change. Reads the container but changes nothing. */
  async plan(target: ContainerTarget, request: RamRequest): Promise<RamPlan | Blocked> {
    if (target.planRamMB <= 0) return { ok: false, code: "NO_PLAN_SIZE", reason: "plan RAM size is unknown" };
    const beforeMB = await this.deps.readMemoryMB(target);
    const { floorMB, ceilingMB } = this.limits(target);

    const wanted = request.toMB ?? beforeMB + (request.addMB ?? this.config.ramExpandChunkMB);
    const afterMB = Math.min(ceilingMB, Math.max(floorMB, Math.round(wanted)));

    if (afterMB === beforeMB) {
      return beforeMB >= ceilingMB && wanted > beforeMB
        ? {
            ok: false,
            code: "AT_RAM_CEILING",
            reason: `already at the maximum ${ceilingMB} MB (${this.config.ramMaxMultiplier}× the ${floorMB} MB plan)`,
            next: { kind: "UPGRADE_PLAN", detail: "client needs a bigger plan for more RAM" },
          }
        : { ok: false, code: "NO_CHANGE", reason: `RAM is already ${beforeMB} MB` };
    }

    const deltaMB = afterMB - beforeMB;
    return {
      ok: true,
      kind: "RAM_SCALE",
      target,
      beforeMB,
      afterMB,
      deltaMB,
      monthlyCostPaise: 0,
      clamped: afterMB !== Math.round(wanted),
      reason: request.reason,
      summary: `${deltaMB > 0 ? "raise" : "lower"} RAM of container ${target.vmid} on ${target.node.name} from ${beforeMB} MB to ${afterMB} MB${
        afterMB === ceilingMB ? " (maximum)" : afterMB === floorMB ? " (plan size)" : ""
      }`,
    };
  }

  /**
   * Applies a plan. Refuses if the container's RAM changed since planning,
   * verifies the result by reading it back, and logs either way.
   */
  async execute(plan: RamPlan, trigger: EngineLogEntry["trigger"]): Promise<{ afterMB: number }> {
    const { target } = plan;
    const base = { serviceId: target.serviceId, vmid: target.vmid, fromNode: target.node.name, trigger, cost: 0 } as const;
    try {
      const current = await this.deps.readMemoryMB(target);
      if (current !== plan.beforeMB) {
        throw new Error(`RAM changed since planning (${plan.beforeMB} → ${current} MB); re-plan`);
      }
      await this.deps.writeMemoryMB(target, plan.afterMB);
      const confirmed = await this.deps.readMemoryMB(target);
      if (confirmed !== plan.afterMB) throw new Error(`Proxmox reports ${confirmed} MB after setting ${plan.afterMB} MB`);

      if (target.serviceId) await this.deps.recordAllocation(target, plan.afterMB);
      await this.deps.log({
        ...base,
        action: plan.deltaMB > 0 ? "RAM_SCALED_UP" : "RAM_SCALED_DOWN",
        before: { memoryMB: plan.beforeMB },
        after: { memoryMB: plan.afterMB, reason: plan.reason },
      });
      return { afterMB: plan.afterMB };
    } catch (err) {
      await this.deps.log({
        ...base,
        action: plan.deltaMB > 0 ? "RAM_SCALED_UP" : "RAM_SCALED_DOWN",
        before: { memoryMB: plan.beforeMB },
        after: { memoryMB: plan.afterMB, reason: plan.reason },
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Records a plan that was only logged (OBSERVE mode) or is waiting for approval. */
  async logPlanOnly(plan: RamPlan, trigger: EngineLogEntry["trigger"], why: string): Promise<void> {
    await this.deps.log({
      action: plan.deltaMB > 0 ? "RAM_SCALE_UP_PLANNED" : "RAM_SCALE_DOWN_PLANNED",
      serviceId: plan.target.serviceId,
      vmid: plan.target.vmid,
      fromNode: plan.target.node.name,
      before: { memoryMB: plan.beforeMB },
      after: { memoryMB: plan.afterMB, reason: plan.reason, notExecutedBecause: why },
      cost: 0,
      trigger,
      dryRun: true,
    });
  }
}
