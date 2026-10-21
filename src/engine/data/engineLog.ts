import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { EngineLogWriter } from "../actions/types";

const json = (v: unknown) => (v === undefined ? undefined : (v as Prisma.InputJsonValue));

/** Writes EngineLog rows. Never throws: a logging failure must not undo or block an action. */
export const prismaEngineLog: EngineLogWriter = async (e) => {
  try {
    await prisma.engineLog.create({
      data: {
        action: e.action,
        serviceId: e.serviceId ?? null,
        vmid: e.vmid === undefined ? null : String(e.vmid),
        fromNode: e.fromNode ?? null,
        toNode: e.toNode ?? null,
        before: json(e.before),
        after: json(e.after),
        cost: e.cost ?? null,
        trigger: e.trigger,
        dryRun: e.dryRun ?? false,
        success: e.success ?? true,
        error: e.error ?? null,
      },
    });
  } catch (err) {
    console.error("[engine:log] could not write EngineLog:", err, e);
  }
};
