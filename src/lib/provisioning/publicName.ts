// A shared-mode service's name and gateway key (Stage C of the shared IPv4 gateway).
//
// Each service gets one name under c.sowsicloud.com: the gateway routes port 80 and 443 by it, and
// from Stage D it's the service's DNS name. Names are unique and never handed to another service,
// like the private address. The order's hostname is used when it's free; otherwise, or when it's
// one we keep for ourselves, a short random suffix is added.
import { randomLowerAlnum } from "@/lib/crypto";

/** The zone service names live in (delegated to Hetzner DNS in Stage D). */
export const SERVICE_ZONE = "c.sowsicloud.com";

/** Names never given to a customer's service. */
const RESERVED = new Set([
  "www", "mail", "smtp", "imap", "pop", "pop3", "mx", "ftp", "ns", "ns1", "ns2", "ns3", "ns4", "dns",
  "api", "admin", "root", "app", "panel", "dashboard", "status", "support", "help", "billing", "pay",
  "gateway", "gw", "proxy", "node", "localhost", "test", "dev", "staging", "prod", "autoconfig", "autodiscover",
]);

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const BASE_MAX = 40;
const SUFFIX = 6;

/** A valid name for a service (one DNS label, no "--", not reserved). */
export function isServiceName(label: string): boolean {
  return LABEL_RE.test(label) && !label.includes("--") && !isReservedName(label);
}

export function isReservedName(label: string): boolean {
  return RESERVED.has(label) || label.startsWith("sowsi");
}

/** The order's hostname as a label: lowercase letters, digits and single hyphens; "server" if nothing is left. */
export function nameBase(hint: string | null | undefined): string {
  const base = (hint ?? "")
    .normalize("NFKD")
    // The accents NFKD split off: "é" becomes "e", not "e-".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BASE_MAX)
    .replace(/-+$/g, "");
  return base || "server";
}

/** The first name to try, then the ones with a suffix. */
export function nameCandidate(hint: string | null | undefined, attempt: number, random = () => randomLowerAlnum(SUFFIX)): string {
  // Our own prefix isn't given out, even with a suffix.
  const base = nameBase(hint).startsWith("sowsi") ? "server" : nameBase(hint);
  if (attempt === 0 && isServiceName(base)) return base;
  return `${base}-${random()}`;
}

export const serviceFqdn = (label: string) => `${label}.${SERVICE_ZONE}`;

export const ROUTE_KEY_RE = /^[a-z0-9]{16}$/;

export type SharedIdentity = { publicName: string; routeKey: string };

export type PublicNameDb = {
  current(serviceId: string): Promise<{ publicName: string | null; routeKey: string | null } | null>;
  /**
   * Sets the field only if the service has none yet. "set": this call set it; "taken": another
   * service has that value (the unique index refused it); "kept": the service already had one.
   */
  setIfEmpty(serviceId: string, field: "publicName" | "routeKey", value: string): Promise<"set" | "taken" | "kept">;
};

const ATTEMPTS = 8;

/**
 * The service's name and route key, assigned on first use. Calling it again returns the same
 * ones. A taken value is simply tried again with a fresh suffix or key.
 */
export async function assignSharedIdentity(db: PublicNameDb, serviceId: string, hint: string | null | undefined, random = () => randomLowerAlnum(SUFFIX), key = () => randomLowerAlnum(16)): Promise<SharedIdentity> {
  const now = await db.current(serviceId);
  if (!now) throw new Error(`service ${serviceId} doesn't exist`);
  const assign = async (field: "publicName" | "routeKey", make: (attempt: number) => string) => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const result = await db.setIfEmpty(serviceId, field, make(attempt));
      if (result !== "taken") return;
    }
    throw new Error(`no free ${field} for service ${serviceId} after ${ATTEMPTS} tries`);
  };
  if (!now.publicName) await assign("publicName", (attempt) => nameCandidate(hint, attempt, random));
  if (!now.routeKey) await assign("routeKey", () => key());
  const after = await db.current(serviceId);
  if (!after?.publicName || !after.routeKey) throw new Error(`service ${serviceId} has no name or route key after assigning them`);
  if (!isServiceName(after.publicName)) throw new Error(`service ${serviceId} has an invalid name "${after.publicName}"`);
  if (!ROUTE_KEY_RE.test(after.routeKey)) throw new Error(`service ${serviceId} has an invalid route key`);
  return { publicName: after.publicName, routeKey: after.routeKey };
}

/** The production database. */
export async function prismaPublicNameDb(): Promise<PublicNameDb> {
  const { prisma } = await import("@/lib/prisma");
  const { Prisma } = await import("@prisma/client");
  return {
    current: (id) => prisma.service.findUnique({ where: { id }, select: { publicName: true, routeKey: true } }),
    async setIfEmpty(id, field, value) {
      try {
        const { count } = await prisma.service.updateMany({ where: { id, [field]: null }, data: { [field]: value } });
        return count === 1 ? "set" : "kept";
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return "taken";
        throw err;
      }
    },
  };
}
