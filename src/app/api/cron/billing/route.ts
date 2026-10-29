import crypto from "node:crypto";
import { runBillingJob } from "@/lib/billing/billingJob";
import { productionOnlyProblem } from "@/lib/environment";
import { runPaidWithoutContainerCheck, runProvisioningSweep } from "@/lib/queue/provisioningSweep";

/**
 * Billing sweep + held/unstarted paid orders — call every 15 minutes from cron on the app server:
 *   *\/15 * * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/billing
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });

  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Suspensions, deletions and provisioning act on real customers: production only.
  const notProduction = productionOnlyProblem("the billing cron");
  if (notProduction) {
    console.error("[cron/billing]", notProduction);
    return Response.json({ error: notProduction }, { status: 503 });
  }

  const summary = await runBillingJob();
  if (summary.errors.length > 0) console.error("[cron/billing]", summary.errors);
  const provisioning = await runProvisioningSweep().catch((err) => {
    console.error("[cron/billing] provisioning sweep failed:", err);
    return { error: err instanceof Error ? err.message : String(err) };
  });
  const paidWithoutServer = await runPaidWithoutContainerCheck().catch((err) => {
    console.error("[cron/billing] paid-without-container check failed:", err);
    return { error: err instanceof Error ? err.message : String(err) };
  });
  return Response.json({ ...summary, provisioning, paidWithoutServer });
}
