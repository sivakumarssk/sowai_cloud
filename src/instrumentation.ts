// Runs once when the Next.js server starts.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertRealProvisioner } = await import("./lib/provisioning/guard");
  // A live environment on the simulator must not take orders at all.
  assertRealProvisioner();
}
