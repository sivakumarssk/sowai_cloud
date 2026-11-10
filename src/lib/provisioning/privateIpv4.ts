// Shared-mode private addresses (Stage A of the shared IPv4 gateway).
//
// Every service that goes shared gets one address from 100.64.0.0/10, once, from the Postgres
// sequence "service_private_ipv4_seq" (migration 20261111090000_private_ipv4). A sequence never
// goes back and the column is unique, so an address is never reused or given to anyone else,
// even after its service is deleted. It stays with the service across a node move.

export const SHARED_RANGE = "100.64.0.0/10";
/** Kept for the installer's test containers: never given to a service. */
export const TEST_BLOCK = "100.127.255.0/24";

/** .1 to .254 of each /24, so no address ends in .0 or .255. */
const PER_BLOCK = 254;
/** 16384 /24 blocks in the /10, less the test block. Matches the sequence's MAXVALUE. */
export const MAX_PRIVATE_INDEX = (16384 - 1) * PER_BLOCK;

const BASE = (100 << 24) | (64 << 16);

/** Sequence value 1 → 100.64.0.1, 254 → 100.64.0.254, 255 → 100.64.1.1, … */
export function privateIpv4ForIndex(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PRIVATE_INDEX) throw new Error(`private IPv4 index ${n} is outside 1..${MAX_PRIVATE_INDEX}`);
  const k = n - 1;
  const addr = (BASE + Math.floor(k / PER_BLOCK) * 256 + (k % PER_BLOCK) + 1) >>> 0;
  return [addr >>> 24, (addr >>> 16) & 255, (addr >>> 8) & 255, addr & 255].join(".");
}

/** The sequence value an address came from, or null if it isn't one a service can have. */
export function privateIpv4Index(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((x) => x > 255) || ip !== `${a}.${b}.${c}.${d}`) return null;
  if (a !== 100 || b < 64 || b > 127 || d < 1 || d > 254) return null;
  const block = (b - 64) * 256 + c;
  const n = block * PER_BLOCK + d;
  return n <= MAX_PRIVATE_INDEX ? n : null;
}

/** In 100.127.255.0/24, the block the installer's test containers use. */
export function isTestPrivateIpv4(ip: string): boolean {
  return /^100\.127\.255\.\d{1,3}$/.test(ip);
}

export type PrivateIpv4Db = {
  /** The service's address, if it has one. */
  current(serviceId: string): Promise<string | null>;
  /** The next value of service_private_ipv4_seq. */
  nextIndex(): Promise<number>;
  /** Sets the address only if the service has none yet; true if this call set it. */
  setIfEmpty(serviceId: string, ip: string): Promise<boolean>;
};

/**
 * The service's private address, assigned on first use. Calling it again returns the same one.
 * If two calls race, one wins and the other's sequence value is simply never used.
 */
export async function assignPrivateIpv4(db: PrivateIpv4Db, serviceId: string): Promise<string> {
  const existing = await db.current(serviceId);
  if (existing) return existing;
  const ip = privateIpv4ForIndex(await db.nextIndex());
  if (await db.setIfEmpty(serviceId, ip)) return ip;
  const winner = await db.current(serviceId);
  if (!winner) throw new Error(`service ${serviceId} has no private IPv4, and setting ${ip} changed nothing (does the service exist?)`);
  return winner;
}

/** The production database. */
export async function prismaPrivateIpv4Db(): Promise<PrivateIpv4Db> {
  const { prisma } = await import("@/lib/prisma");
  return {
    current: async (id) => (await prisma.service.findUnique({ where: { id }, select: { privateIpv4: true } }))?.privateIpv4 ?? null,
    nextIndex: async () => Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT nextval('service_private_ipv4_seq') AS n`)[0].n),
    setIfEmpty: async (id, ip) => (await prisma.service.updateMany({ where: { id, privateIpv4: null }, data: { privateIpv4: ip } })).count === 1,
  };
}
