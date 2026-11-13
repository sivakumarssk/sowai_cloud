// Read-only diagnosis of the Microsoft 365 (Graph) mail setup, for scripts/prod/mail-check.ts.
// Nothing here sends mail. The access token is only decoded for its claims and never returned.

export type TokenClaims = { appId: string | null; tenantId: string | null; audience: string | null; roles: string[]; expiresAt: string | null };

/** The claims of a Graph access token (a JWT): which app, which tenant, which application permissions. */
export function tokenClaims(jwt: string): TokenClaims {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("the access token isn't a JWT");
  const json = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    appId: str(json.appid) ?? str(json.azp),
    tenantId: str(json.tid),
    audience: str(json.aud),
    roles: Array.isArray(json.roles) ? json.roles.map(String).sort() : [],
    expiresAt: typeof json.exp === "number" ? new Date(json.exp * 1000).toISOString() : null,
  };
}

/** What the token says about sending, in words. */
export function checkClaims(c: TokenClaims, tenantId: string): string[] {
  const problems: string[] = [];
  if (c.tenantId !== tenantId) problems.push(`the token is for tenant ${c.tenantId ?? "none"}, not MS_TENANT_ID`);
  if (c.audience !== "https://graph.microsoft.com" && c.audience !== "00000003-0000-0000-c000-000000000000") problems.push(`the token is for ${c.audience ?? "no audience"}, not Microsoft Graph`);
  if (!c.roles.includes("Mail.Send")) problems.push(`the app has no admin-consented application permission Mail.Send (it has: ${c.roles.join(", ") || "none"})`);
  return problems;
}

export type GraphReply = { status: number; code: string | null; message: string | null; requestId: string | null; diagnostic: string | null };

/** One line for a read-only Graph call: status, Graph's error code, and the ids Microsoft support asks for. */
export function describeReply(label: string, r: GraphReply, needs: string): string {
  const ids = [r.requestId && `request-id ${r.requestId}`, r.diagnostic && `diagnostic ${r.diagnostic}`].filter(Boolean).join(", ");
  if (r.status === 200) return `${label}: 200 OK${ids ? ` (${ids})` : ""}`;
  const why =
    r.status === 403 ? `refused: the app lacks ${needs}, or an Exchange application access policy keeps it from this mailbox` :
    r.status === 404 ? "not found: MAIL_FROM isn't a user or mailbox in this tenant (or has no Exchange Online mailbox)" :
    r.status >= 500 ? "Microsoft's side failed" :
    "unexpected";
  return `${label}: ${r.status} ${r.code ?? ""} ${(r.message ?? "").slice(0, 160)} — ${why}${ids ? ` (${ids})` : ""}`.replace(/\s+/g, " ");
}
