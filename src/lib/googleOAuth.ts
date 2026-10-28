/** Holds the OAuth state nonce between /api/auth/google and its callback. */
export const GOOGLE_STATE_COOKIE = "google_oauth_state";

/** Only same-site paths — never "//evil.com" or an absolute URL. */
export function safeRedirectPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/dashboard";
  return value;
}
