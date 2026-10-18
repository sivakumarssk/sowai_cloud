// Minimal component logger for the engine (PM2 captures stdout/stderr).
// Format: 2026-10-17T20:30:00.000Z [engine:containers] message

export type Logger = {
  info: (message: string, ...extra: unknown[]) => void;
  warn: (message: string, ...extra: unknown[]) => void;
  error: (message: string, ...extra: unknown[]) => void;
};

export function createLogger(component: string): Logger {
  const prefix = () => `${new Date().toISOString()} [engine:${component}]`;
  return {
    info: (message, ...extra) => console.log(prefix(), message, ...extra),
    warn: (message, ...extra) => console.warn(prefix(), message, ...extra),
    error: (message, ...extra) => console.error(prefix(), message, ...extra),
  };
}

/** Logger that discards everything (tests). */
export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
