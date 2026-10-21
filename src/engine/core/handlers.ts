// What each automatable decision does when it runs. Every handler re-plans
// against current state first: an approval can be up to 2 hours old.

import type { ActionHandler, HandlerContext } from "./ActionExecutor";
import type { ClientNoticeTemplate, DecisionPayload } from "./decisions";
import type { ActionKind } from "./policy";
import type { ContainerTarget } from "../actions/types";
import type { RamScaler } from "../actions/RamScaler";
import type { DiskExpander } from "../actions/DiskExpander";
import type { VolumeManager, VolumeNode } from "../actions/VolumeManager";

export type HandlerDeps = {
  target(serviceId: string): Promise<ContainerTarget>;
  ramScaler: Pick<RamScaler, "plan" | "execute">;
  diskExpander: Pick<DiskExpander, "plan" | "execute">;
  volumeManager: Pick<VolumeManager, "plan" | "execute">;
  volumeNode(nodeName: string): Promise<VolumeNode>;
  notifyClient(serviceId: string, template: ClientNoticeTemplate, detail: string): Promise<void>;
  alertAdmin(title: string, detail: string): Promise<void>;
  /** Sets ProxmoxNode.acceptNewClients = false. Returns false if it already was. */
  stopSignups(nodeName: string): Promise<boolean>;
};

type Of<K extends DecisionPayload["kind"]> = Extract<DecisionPayload, { kind: K }>;

function expect<K extends DecisionPayload["kind"]>(payload: DecisionPayload, kind: K): Of<K> {
  if (payload.kind !== kind) throw new Error(`expected a ${kind} payload, got ${payload.kind}`);
  return payload as Of<K>;
}

const trigger = (ctx: HandlerContext) => (ctx.approval ? "MANUAL" : ctx.trigger);

export function buildHandlers(deps: HandlerDeps): Partial<Record<ActionKind, ActionHandler>> {
  return {
    async RAM_SCALE(payload, ctx) {
      const p = expect(payload, "RAM_SCALE");
      const plan = await deps.ramScaler.plan(await deps.target(p.serviceId), { addMB: p.addMB, reason: "engine decision" });
      if (!plan.ok) return `skipped: ${plan.reason}`;
      const { afterMB } = await deps.ramScaler.execute(plan, trigger(ctx));
      return `RAM ${plan.beforeMB} → ${afterMB} MB`;
    },

    async DISK_EXPAND(payload, ctx) {
      const p = expect(payload, "DISK_EXPAND");
      const plan = await deps.diskExpander.plan(await deps.target(p.serviceId), { purpose: p.purpose, addGB: p.addGB, reason: "engine decision" });
      if (!plan.ok) return `skipped: ${plan.reason}`;
      const after = await deps.diskExpander.execute(plan, trigger(ctx));
      if (after.queuedUntilRestart) return `${plan.summary} → queued until the container restarts (${after.queuedUntilRestart})`;
      return `${plan.summary} → root ${after.rootGB} GB, /data ${after.dataGB} GB`;
    },

    async VOLUME_PURCHASE(payload, ctx) {
      const p = expect(payload, "VOLUME_PURCHASE");
      // Never on the engine's own say-so, whatever the settings.
      if (!ctx.approval?.approvedBy?.trim()) throw new Error("admin approval required to buy a Volume");
      const plan = await deps.volumeManager.plan(await deps.volumeNode(p.nodeName), { sizeGB: p.sizeGB, reason: "engine decision, approved" });
      if (!plan.ok) throw new Error(plan.reason);
      const v = await deps.volumeManager.execute(plan, ctx.approval);
      return `Volume ${v.hetznerVolumeId} (${plan.sizeGB} GB) attached as ${v.storage}`;
    },

    async NOTIFY_CLIENT(payload) {
      const p = expect(payload, "NOTIFY_CLIENT");
      await deps.notifyClient(p.serviceId, p.template, p.detail);
      return `client emailed (${p.template})`;
    },

    async ALERT_ADMIN(payload) {
      const p = expect(payload, "ALERT_ADMIN");
      await deps.alertAdmin(p.title, p.detail);
      return "admin alerted";
    },

    async STOP_SIGNUPS(payload) {
      const p = expect(payload, "STOP_SIGNUPS");
      return (await deps.stopSignups(p.nodeName)) ? `${p.nodeName} no longer accepts new clients` : `${p.nodeName} already closed to new clients`;
    },
  };
}
