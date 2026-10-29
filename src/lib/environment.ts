// Which environment this is, and what it may touch.
//
//   APP_ENV=development  test Razorpay keys, PROVISIONER=simulated, and no
//                        Hetzner/Proxmox token unless ALLOW_REAL_INFRA=1.
//   APP_ENV=production   live Razorpay keys and PROVISIONER=proxmox.
//
// Anything else refuses to start. Checked by `next build` / `next dev` /
// `next start` (next.config.ts), the server at boot (instrumentation.ts), and
// every script. The billing cron and the engine also require production.
//
// No "@/" imports: next.config.ts loads this file directly.

type Env = Record<string, string | undefined>;

export type AppEnv = "development" | "production";

const val = (env: Env, key: string) => env[key]?.trim() ?? "";

/** "development" | "production", or null when APP_ENV is missing or anything else. */
export function appEnv(env: Env = process.env): AppEnv | null {
  const v = val(env, "APP_ENV");
  return v === "development" || v === "production" ? v : null;
}

/** Production, or taking real money: APP_ENV=production, or a live Razorpay key. */
export function isLiveEnvironment(env: Env = process.env): boolean {
  return appEnv(env) === "production" || razorpayKeys(env).some(([, k]) => k.startsWith("rzp_live_"));
}

/** True when paid VPS orders build real Proxmox containers. */
export function usesRealProvisioner(env: Env = process.env): boolean {
  return val(env, "PROVISIONER") === "proxmox";
}

/** [variable, key id] for each Razorpay key id that is set. */
function razorpayKeys(env: Env): [string, string][] {
  return (["RAZORPAY_KEY_ID", "NEXT_PUBLIC_RAZORPAY_KEY_ID"] as const).map((name): [string, string] => [name, val(env, name)]).filter(([, k]) => k);
}

/** Tokens that reach real infrastructure (Hetzner Cloud API, Proxmox API). */
const INFRA_TOKENS = ["HETZNER_API_TOKEN", "PROXMOX_TOKEN_ID", "PROXMOX_TOKEN_SECRET"];

/** Everything wrong with this environment (empty = it may run). */
export function environmentProblems(env: Env = process.env): string[] {
  const mode = appEnv(env);
  const provisioner = val(env, "PROVISIONER");
  const keys = razorpayKeys(env);

  if (mode === null) {
    const given = val(env, "APP_ENV");
    return [`APP_ENV is ${given ? `"${given}"` : "not set"} — set APP_ENV=development on your machine or APP_ENV=production on the live server`];
  }

  const problems: string[] = [];
  if (mode === "development") {
    for (const [name, k] of keys) if (k.startsWith("rzp_live_")) problems.push(`${name} is a live Razorpay key (rzp_live_…) — development uses rzp_test_ keys only`);
    const tokens = INFRA_TOKENS.filter((k) => val(env, k));
    if (tokens.length > 0 && val(env, "ALLOW_REAL_INFRA") !== "1") {
      problems.push(`${tokens.join(", ")} ${tokens.length === 1 ? "is" : "are"} set — remove ${tokens.length === 1 ? "it" : "them"}, or set ALLOW_REAL_INFRA=1 to use real Hetzner/Proxmox from development`);
    }
    if (provisioner !== "simulated") problems.push(`PROVISIONER is "${provisioner}" — development requires PROVISIONER=simulated`);
  } else {
    if (keys.length === 0) problems.push("RAZORPAY_KEY_ID is not set — production needs the live key (rzp_live_…)");
    for (const [name, k] of keys) if (!k.startsWith("rzp_live_")) problems.push(`${name} (${k.slice(0, 9)}…) is not a live key — production takes real payments only (rzp_live_…)`);
    if (provisioner !== "proxmox") problems.push(`PROVISIONER is "${provisioner}" — production requires PROVISIONER=proxmox (anything else would "fulfil" paid orders without a server)`);
  }
  return problems;
}

/** Throws when this environment must not run. */
export function assertEnvironment(env: Env = process.env): void {
  const problems = environmentProblems(env);
  if (problems.length > 0) throw new Error(`Refusing to start (APP_ENV=${val(env, "APP_ENV") || "unset"}):\n  - ${problems.join("\n  - ")}`);
}

/** Why `what` must not run here (it needs APP_ENV=production), or null. */
export function productionOnlyProblem(what: string, env: Env = process.env): string | null {
  if (appEnv(env) !== "production") return `Refusing to run ${what}: it only runs with APP_ENV=production (this is ${val(env, "APP_ENV") || "unset"})`;
  const problems = environmentProblems(env);
  return problems.length > 0 ? `Refusing to run ${what}:\n  - ${problems.join("\n  - ")}` : null;
}

/** Throws unless this is a valid production environment. */
export function assertProduction(what: string, env: Env = process.env): void {
  const problem = productionOnlyProblem(what, env);
  if (problem) throw new Error(problem);
}
