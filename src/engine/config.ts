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

    hysteresisPct: num(env, "ENGINE_HYSTERESIS_PCT", 5),
  };

  ascending("RAM", [config.ramWarningPct, config.ramCriticalPct, config.ramEmergencyPct]);
  ascending("Disk", [config.diskWarningPct, config.diskCriticalPct, config.diskFullPct]);
  ascending("Server", [config.serverWarningPct, config.serverCriticalPct]);
  if (config.containerPollMs < 5000) throw new Error("CONTAINER_POLL_SECONDS must be at least 5");
  return config;
}
