// Threshold levels with hysteresis, shared by the container and server monitors.

/** 0 = normal; 1, 2, 3 = first, second, third threshold exceeded. */
export type Level = 0 | 1 | 2 | 3;

/**
 * Level for a usage percentage. Rising: the highest threshold exceeded (thresholds
 * are exclusive: 75 means "> 75%"). Falling: a level is only left once usage drops
 * `hysteresis` points below its threshold, so 84↔86% doesn't flap.
 */
export function nextLevel(pct: number, current: Level, thresholds: readonly number[], hysteresis: number): Level {
  const raw = thresholds.filter((t) => pct > t).length as Level;
  if (raw >= current) return raw;
  let level = current;
  while (level > raw && pct < thresholds[level - 1] - hysteresis) level = (level - 1) as Level;
  return level;
}

/**
 * Tracks "above threshold for at least N ms". Returns how long the value has
 * been above (ms) once that's ≥ duration, otherwise null; `cleared` is true on
 * the poll the condition ends (usage fell below threshold − hysteresis).
 */
export function sustained(
  pct: number,
  since: number | null,
  now: number,
  threshold: number,
  durationMs: number,
  hysteresis: number
): { since: number | null; firingMs: number | null; cleared: boolean } {
  if (pct > threshold) {
    const start = since ?? now;
    return { since: start, firingMs: now - start >= durationMs ? now - start : null, cleared: false };
  }
  if (since !== null && pct < threshold - hysteresis) return { since: null, firingMs: null, cleared: true };
  return { since, firingMs: null, cleared: false };
}
