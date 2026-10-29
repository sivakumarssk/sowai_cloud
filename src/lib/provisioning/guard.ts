// Never sell real servers through the simulator.
//
// No "@/" imports: next.config.ts loads this file directly.

type Env = Record<string, string | undefined>;

/** Production, or taking real money: APP_ENV=production, or a live Razorpay key. */
export function isLiveEnvironment(env: Env = process.env): boolean {
  return env.APP_ENV?.trim() === "production" || Boolean(env.RAZORPAY_KEY_ID?.trim().startsWith("rzp_live_"));
}

/** True when paid VPS orders build real Proxmox containers. */
export function usesRealProvisioner(env: Env = process.env): boolean {
  return env.PROVISIONER?.trim() === "proxmox";
}

/** Why this environment must not run, or null if it may. */
export function provisionerProblem(env: Env = process.env): string | null {
  if (!isLiveEnvironment(env) || usesRealProvisioner(env)) return null;
  const why = env.APP_ENV?.trim() === "production" ? "APP_ENV=production" : "RAZORPAY_KEY_ID is a live key (rzp_live_…)";
  return `Refusing to start: ${why} but PROVISIONER="${env.PROVISIONER ?? ""}". Live payments would be "fulfilled" by the simulator with a fake IP and no server. Set PROVISIONER=proxmox.`;
}

/** Throws (stopping `next build` / `next start` / the job) when a live environment isn't on the real provisioner. */
export function assertRealProvisioner(env: Env = process.env): void {
  const problem = provisionerProblem(env);
  if (problem) throw new Error(problem);
}
