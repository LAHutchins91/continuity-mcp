import { LEGACY_APP_ORIGIN, PUBLIC_APP_ORIGIN } from "./public-url.js";

/** Browser origins that may call /mcp. Clients that omit Origin (typical server-side MCP) are allowed. */
export const MCP_BROWSER_ORIGINS = [
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://claude.ai",
  "https://gemini.google.com",
  "https://grok.com",
  "https://cursor.com",
  "https://www.cursor.com"
] as const;

/** Both production hosts serve this app. Allow either Origin when APP_BASE_URL is the other one. */
const CONTINUITY_APP_ORIGINS = [PUBLIC_APP_ORIGIN, LEGACY_APP_ORIGIN] as const;

export function mcpBrowserOriginAllowed(origin: string | undefined, appBaseUrl: string) {
  if (!origin) return true;
  const base = appBaseUrl.replace(/\/$/, "");
  return origin === base
    || (CONTINUITY_APP_ORIGINS as readonly string[]).includes(origin)
    || (MCP_BROWSER_ORIGINS as readonly string[]).includes(origin);
}

export const MCP_CORS_HEADERS = {
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "600"
};
