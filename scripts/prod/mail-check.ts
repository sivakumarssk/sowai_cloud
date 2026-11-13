/**
 * Read-only check of the Microsoft 365 mail setup: why Graph might refuse or fail a sendMail.
 *
 *   npx tsx scripts/prod/mail-check.ts
 *
 * Signs in with MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET exactly as src/lib/mailer.ts does,
 * then only reads: the token's claims (app, tenant, application permissions), the MAIL_FROM user,
 * and its mailbox settings. It never calls sendMail, so no mail goes anywhere. Prints no secret and
 * no token: only claims, HTTP statuses, Graph's error codes and the request ids Microsoft asks for.
 * A 403 on a read here can just mean the app wasn't given that read permission; sending needs only
 * Mail.Send.
 */
import { config as loadEnv } from "dotenv";
import { exitUnlessEnvironment } from "../lib/env";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });
exitUnlessEnvironment();

(async () => {
  const { checkClaims, describeReply, tokenClaims } = await import("../../src/lib/mailCheck");
  const env = (k: string) => process.env[k]?.trim() || "";
  const tenant = env("MS_TENANT_ID");
  const from = env("MAIL_FROM");
  const missing = ["MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "MAIL_FROM"].filter((k) => !env(k));
  console.log(`settings: ${missing.length ? `MISSING ${missing.join(", ")} (mailer.ts then falls back to Resend, or sends nothing)` : "MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and MAIL_FROM are set"}`);
  if (missing.length) return void (process.exitCode = 1);
  console.log(`sender (MAIL_FROM): ${from}`);

  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("MS_CLIENT_ID"), client_secret: env("MS_CLIENT_SECRET"), scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    console.log(`1. sign-in: FAILED ${res.status} ${body.error ?? ""} ${body.error_description?.split("\r\n")[0] ?? ""}`);
    return void (process.exitCode = 1);
  }
  const token = body.access_token;
  const claims = tokenClaims(token);
  const problems = checkClaims(claims, tenant);
  console.log(`1. sign-in: ok; app ${claims.appId}, application permissions: ${claims.roles.join(", ") || "none"}; token valid until ${claims.expiresAt}`);
  for (const p of problems) console.log(`   PROBLEM: ${p}`);

  const get = async (path: string) => {
    const r = await fetch(`https://graph.microsoft.com/v1.0${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: { code?: string; message?: string } };
    return { reply: { status: r.status, code: json.error?.code ?? null, message: json.error?.message ?? null, requestId: r.headers.get("request-id"), diagnostic: r.headers.get("x-ms-ags-diagnostic") }, json };
  };
  const user = await get(`/users/${encodeURIComponent(from)}?$select=id,userPrincipalName,mail,accountEnabled,assignedLicenses`);
  console.log(`2. ${describeReply("the sender user", user.reply, "User.Read.All")}`);
  if (user.reply.status === 200) {
    const u = user.json as { userPrincipalName?: string; mail?: string; accountEnabled?: boolean; assignedLicenses?: unknown[] };
    console.log(`   ${u.userPrincipalName} (mail ${u.mail ?? "none"}), account ${u.accountEnabled ? "enabled" : "DISABLED"}, ${u.assignedLicenses?.length ?? 0} licence(s)`);
  }
  const box = await get(`/users/${encodeURIComponent(from)}/mailboxSettings`);
  console.log(`3. ${describeReply("its mailbox", box.reply, "MailboxSettings.Read")}`);
  if (box.reply.status === 200) console.log(`   mailbox present (time zone ${String((box.json as { timeZone?: string }).timeZone ?? "unknown")})`);
  console.log("\nNothing was sent. For a failed send, Microsoft support asks for the request-id of that request; mailer.ts doesn't log it yet (ROADMAP.md).");
  if (problems.length) process.exitCode = 1;
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
