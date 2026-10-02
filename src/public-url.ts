/** Custom domain for the same production app. Public connect copy prefers this host. */
export const PUBLIC_APP_ORIGIN = "https://continuitywriter.com";

/** Previous production host. Existing OAuth grants are still bound to this resource. */
export const LEGACY_APP_ORIGIN = "https://continuity-snowy.vercel.app";

export function canonicalPublicOrigin(appBaseUrl: string) {
  const base = appBaseUrl.replace(/\/$/, "");
  if (base === LEGACY_APP_ORIGIN) return PUBLIC_APP_ORIGIN;
  return base;
}

/** Legacy MCP URL to mention on production hosts. Other bases stay silent. */
export function legacyMcpUrl(appBaseUrl: string) {
  const base = appBaseUrl.replace(/\/$/, "");
  if (base === LEGACY_APP_ORIGIN || base === PUBLIC_APP_ORIGIN) return `${LEGACY_APP_ORIGIN}/mcp`;
  return null;
}
