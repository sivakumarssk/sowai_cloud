import { Resend } from "resend";

export type Mail = { to: string | string[]; subject: string; html: string };

/**
 * Sends one HTML email. Transport, in order of preference:
 *   1. Microsoft 365 via Graph (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MAIL_FROM)
 *   2. Resend (RESEND_API_KEY, EMAIL_FROM)
 * Returns false (and logs) when no transport is configured; throws if sending fails.
 */
export async function sendMail(mail: Mail): Promise<boolean> {
  const to = (Array.isArray(mail.to) ? mail.to : [mail.to]).filter(Boolean);
  if (to.length === 0) return false;

  if (graphConfigured()) {
    await sendViaGraph({ ...mail, to });
    return true;
  }
  const resend = resendClient();
  if (resend) {
    await resend.emails.send({ from: process.env.EMAIL_FROM || "noreply@sowsicloud.com", to, subject: mail.subject, html: mail.html });
    return true;
  }
  console.warn(`[mail] no mail transport configured — skipping "${mail.subject}" to ${to.join(", ")}`);
  return false;
}

// ── Microsoft 365 (Graph, app-only) ───────────────────────────────────
// Needs an Entra ID app registration with the *application* permission
// Mail.Send (admin-consented). MAIL_FROM must be a mailbox in the tenant.

function graphConfigured(): boolean {
  return Boolean(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && process.env.MAIL_FROM);
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function graphToken(): Promise<string> {
  // Refresh a minute early so a token never expires mid-request.
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.value;

  const res = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID!,
      client_secret: process.env.MS_CLIENT_SECRET!,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    // error_description's first line is the useful part (e.g. "AADSTS7000215: Invalid client secret provided").
    throw new Error(`Microsoft sign-in failed: ${body.error_description?.split("\r\n")[0] ?? body.error ?? res.status}`);
  }
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

async function sendViaGraph(mail: { to: string[]; subject: string; html: string }): Promise<void> {
  const from = process.env.MAIL_FROM!;
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await graphToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: mail.subject,
        body: { contentType: "HTML", content: mail.html },
        toRecipients: mail.to.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: false,
    }),
  });
  if (res.status !== 202) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    throw new Error(`Microsoft sendMail failed (${res.status}): ${body.error?.code ?? ""} ${body.error?.message ?? ""}`.trim());
  }
}

// ── Resend (fallback) ─────────────────────────────────────────────────

let resend: Resend | null = null;

function resendClient(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  // Ignore the placeholder from .env.example.
  if (!key || key.startsWith("re_xxx")) return null;
  resend ??= new Resend(key);
  return resend;
}
