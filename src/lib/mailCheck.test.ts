import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkClaims, describeReply, tokenClaims } from "./mailCheck";

const jwt = (claims: Record<string, unknown>) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const TENANT = "11111111-2222-3333-4444-555555555555";

test("the token's claims: app, tenant, Graph, and whether Mail.Send was granted", () => {
  const c = tokenClaims(jwt({ appid: "app-1", tid: TENANT, aud: "https://graph.microsoft.com", roles: ["User.Read.All", "Mail.Send"], exp: 1_800_000_000 }));
  assert.deepEqual(c, { appId: "app-1", tenantId: TENANT, audience: "https://graph.microsoft.com", roles: ["Mail.Send", "User.Read.All"], expiresAt: "2027-01-15T08:00:00.000Z" });
  assert.deepEqual(checkClaims(c, TENANT), []);
  assert.match(checkClaims({ ...c, roles: [] }, TENANT).join(), /no admin-consented application permission Mail.Send \(it has: none\)/);
  assert.match(checkClaims(c, "other").join(), /not MS_TENANT_ID/);
  assert.match(checkClaims({ ...c, audience: "api://x" }, TENANT).join(), /not Microsoft Graph/);
  assert.throws(() => tokenClaims("not-a-jwt"), /isn't a JWT/);
});

test("each read says what a status means, with the ids Microsoft support asks for", () => {
  const r = { status: 403, code: "ErrorAccessDenied", message: "Access is denied.", requestId: "r-1", diagnostic: "{\"ServerInfo\":{}}" };
  assert.match(describeReply("its mailbox", r, "MailboxSettings.Read"), /^its mailbox: 403 ErrorAccessDenied Access is denied\. — refused: the app lacks MailboxSettings\.Read, or an Exchange application access policy/);
  assert.match(describeReply("its mailbox", r, "MailboxSettings.Read"), /request-id r-1/);
  assert.match(describeReply("x", { ...r, status: 404 }, ""), /isn't a user or mailbox in this tenant/);
  assert.match(describeReply("x", { ...r, status: 502, code: "UnknownError" }, ""), /502 UnknownError .*Microsoft's side failed/);
  assert.equal(describeReply("x", { ...r, status: 200 }, ""), 'x: 200 OK (request-id r-1, diagnostic {"ServerInfo":{}})');
});

test("the check only reads: no sendMail, no POST to Graph, and it prints no secret or token", () => {
  const src = readFileSync(path.join(process.cwd(), "scripts", "prod", "mail-check.ts"), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*\*)/.test(l)).join("\n");
  assert.doesNotMatch(code, /sendMail\(|\/sendMail|sendViaGraph|new Resend|resend\.|from "@?\S*mailer"/, "nothing that sends");
  assert.equal((code.match(/method: "POST"/g) ?? []).length, 1, "the only POST is the sign-in");
  assert.match(code, /login\.microsoftonline\.com\/\$\{encodeURIComponent\(tenant\)\}\/oauth2\/v2\.0\/token[^\n]*\n\s*method: "POST"/);
  for (const line of code.split("\n").filter((l) => /console\.(log|error)\(/.test(l))) {
    // The values themselves, interpolated or passed: the token, the secret.
    assert.doesNotMatch(line, /\$\{token\b|[(,]\s*token\s*[),]|access_token|env\("MS_CLIENT_SECRET"\)|process\.env\.MS_CLIENT_SECRET|client_secret/, line.trim());
  }
});
