// Engine thresholds and timings, read from the environment once at startup.
// All percentages are of the current limit (container) or physical capacity (node).

export type EngineConfig = {
  containerPollMs: number;
  serverPollMs: number;

  ramWarningPct: number;
  ramCriticalPct: number;
  ramEmergencyPct: number;

  diskWarningPct: number;
  diskCriticalPct: number;
  diskFullPct: number;

  cpuAlertPct: number;
  /** How long CPU must stay above cpuAlertPct before CPU_HIGH. */
  cpuAlertDurationMs: number;

  serverWarningPct: number;
  serverCriticalPct: number;
  serverEmergencyPct: number;
  /** SERVER_FULL: RAM or disk above this. */
  serverFullPct: number;
  /** SERVER_OVERLOADED: CPU above serverCpuPct for serverCpuDurationMs. */
  serverCpuPct: number;
  serverCpuDurationMs: number;

  /** Proxmox storage holding container root disks (the "free pool"). */
  containerStorage: string;
  /** Space on the free pool that's never handed out (headroom for the host and growth). */
  diskPoolReserveGB: number;
  /** Default size of one disk expansion. */
  diskExpandChunkGB: number;
  /** Hetzner Volume cost, paise per GB per month (₹5.30 = 530). */
  volumeCostPerGbPaise: number;
  /** Size of a Hetzner Volume the engine proposes buying (₹530/month at 100 GB). */
  volumeSizeGB: number;

  /** Default size of one RAM increase. */
  ramExpandChunkMB: number;
  /** A container's RAM may be raised to at most plan × this. Never lowered below the plan. */
  ramMaxMultiplier: number;

  /**
   * Usage must fall this many percentage points below a threshold before the
   * level is considered cleared (stops flapping around a threshold).
   */
  hysteresisPct: number;
};

type Env = Record<string, string | undefined>;

function num(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  // Allow trailing comments like "300  # 5 minutes" from .env files.
  const value = Number(raw.split("#")[0].trim());
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  return value;
}

function ascending(name: string, values: number[]) {
  for (let i = 1; i < values.length; i++) {
    if (!(values[i - 1] < values[i])) throw new Error(`${name} thresholds must increase: ${values.join(" < ")}`);
  }
  if (values[values.length - 1] > 100) throw new Error(`${name} thresholds must be ≤ 100`);
}

export function loadEngineConfig(env: Env = process.env): EngineConfig {
  const config: EngineConfig = {
    containerPollMs: num(env, "CONTAINER_POLL_SECONDS", 30) * 1000,
    serverPollMs: num(env, "SERVER_POLL_SECONDS", 30) * 1000,

    ramWarningPct: num(env, "RAM_WARNING_PCT", 75),
    ramCriticalPct: num(env, "RAM_CRITICAL_PCT", 85),
    ramEmergencyPct: num(env, "RAM_EMERGENCY_PCT", 95),

    diskWarningPct: num(env, "DISK_WARNING_PCT", 75),
    diskCriticalPct: num(env, "DISK_CRITICAL_PCT", 85),
    diskFullPct: num(env, "DISK_FULL_PCT", 98),

    cpuAlertPct: num(env, "CPU_ALERT_PCT", 85),
    cpuAlertDurationMs: num(env, "CPU_ALERT_DURATION", 300) * 1000,

    serverWarningPct: num(env, "SERVER_WARNING_PCT", 70),
    serverCriticalPct: num(env, "SERVER_CRITICAL_PCT", 80),
    serverEmergencyPct: num(env, "SERVER_EMERGENCY_PCT", 90),
    serverFullPct: num(env, "SERVER_FULL_PCT", 85),
    serverCpuPct: num(env, "SERVER_CPU_OVERLOAD_PCT", 90),
    serverCpuDurationMs: num(env, "SERVER_CPU_OVERLOAD_DURATION", 600) * 1000,

    containerStorage: (env.PROXMOX_STORAGE ?? "").trim() || "local",
    diskPoolReserveGB: num(env, "DISK_POOL_RESERVE_GB", 20),
    diskExpandChunkGB: num(env, "DISK_EXPAND_CHUNK_GB", 10),
    volumeCostPerGbPaise: num(env, "VOLUME_COST_PER_GB", 530),
    volumeSizeGB: num(env, "VOLUME_SIZE_GB", 100),

    ramExpandChunkMB: num(env, "RAM_EXPAND_CHUNK_MB", 512),
    ramMaxMultiplier: num(env, "RAM_MAX_MULTIPLIER", 2),

    hysteresisPct: num(env, "ENGINE_HYSTERESIS_PCT", 5),
  };

  ascending("RAM", [config.ramWarningPct, config.ramCriticalPct, config.ramEmergencyPct]);
  ascending("Disk", [config.diskWarningPct, config.diskCriticalPct, config.diskFullPct]);
  ascending("Server", [config.serverWarningPct, config.serverCriticalPct, config.serverEmergencyPct]);
  if (config.ramMaxMultiplier < 1) throw new Error("RAM_MAX_MULTIPLIER must be at least 1 (RAM is never lowered below the plan)");
  if (config.diskExpandChunkGB < 1 || config.ramExpandChunkMB < 64) {
    throw new Error("DISK_EXPAND_CHUNK_GB must be ≥ 1 and RAM_EXPAND_CHUNK_MB ≥ 64");
  }
  if (config.volumeSizeGB < 10 || config.volumeSizeGB > 10_240) throw new Error("VOLUME_SIZE_GB must be 10–10240 (Hetzner limits)");
  if (config.containerPollMs < 5000) throw new Error("CONTAINER_POLL_SECONDS must be at least 5");
  return config;
}
