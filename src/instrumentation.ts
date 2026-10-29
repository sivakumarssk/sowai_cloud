// Runs once when the Next.js server starts.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertEnvironment } = await import("./lib/environment");
  // A mixed-up environment (live keys in development, the simulator in production) must not take orders at all.
  assertEnvironment();
}
