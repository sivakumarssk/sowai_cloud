// What the DecisionMaker proposes. A Decision is a plan plus everything needed
// to re-plan and run it later (payload) — approvals store the payload and the
// action is re-planned against current state when it's approved.

import type { ActionKind } from "./policy";

export type ClientNoticeTemplate = "STORAGE_ALMOST_FULL" | "STORAGE_FULL" | "UPGRADE_RAM";

export type DecisionPayload =
  | { kind: "RAM_SCALE"; serviceId: string; addMB: number }
  | { kind: "DISK_EXPAND"; serviceId: string; purpose: "EXTRA_SPACE" | "GROW_TO_PLAN"; addGB?: number }
  | { kind: "VOLUME_PURCHASE"; nodeName: string; sizeGB: number }
  | { kind: "SERVER_PURCHASE"; nodeName: string }
  | { kind: "MIGRATION"; serviceId?: string; nodeName: string; urgency: "TONIGHT" | "PLANNED"; detail: string }
  | { kind: "NOTIFY_CLIENT"; serviceId: string; template: ClientNoticeTemplate; detail: string }
  | { kind: "ALERT_ADMIN"; title: string; detail: string }
  | { kind: "STOP_SIGNUPS"; nodeName: string };

export type Decision = {
  kind: ActionKind;
  /** "service:<id>" or "node:<name>" — one open approval per kind + subject. */
  subject: string;
  summary: string;
  /** The event that led to it, in words. */
  reason: string;
  /** New monthly spend if carried out, paise. */
  monthlyCostPaise: number;
  payload: DecisionPayload;
};
