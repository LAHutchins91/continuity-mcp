import { canonicalPublicOrigin, legacyMcpUrl } from "./public-url.js";

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch));
}

/** Landing sentence. Uses the custom domain when the configured base is the legacy Vercel host. */
export function landingConnectLead(baseUrl: string) {
  const origin = canonicalPublicOrigin(baseUrl);
  const mcp = htmlEscape(`${origin}/mcp`);
  const connect = htmlEscape(`${origin}/connect`);
  return `<p>MCP address: <code>${mcp}</code>. <a href="${connect}">Connect an assistant</a>.</p>`;
}

/** Public install steps. Keep docs/CONNECT.md aligned with this copy. */
export function connectPageBody(baseUrl: string) {
  const origin = canonicalPublicOrigin(baseUrl);
  const mcp = htmlEscape(`${origin}/mcp`);
  const fallback = legacyMcpUrl(baseUrl);
  const fallbackHtml = fallback
    ? `<p>The earlier address <code>${htmlEscape(fallback)}</code> still reaches this server.</p>`
    : "";
  return `<p>Continuity is one OAuth-protected story bible for ChatGPT, Claude, Gemini, Grok, Cursor, and any other MCP client that can reach this server. Story tools still require your Continuity account with Pro or an active trial. Billing stays in the workspace; no assistant can change your plan.</p>
<section><h2>Shared connection</h2>
<p>MCP address:</p><p><code>${mcp}</code></p>
${fallbackHtml}
<p>Transport: Streamable HTTP. Sign in with your own Continuity account when the assistant opens OAuth. Do not paste an API key, access token, or password into a header or chat. Revoke a host at any time from <a href="/connections">connected applications</a>.</p>
<ol><li><a href="/app">Sign in to the workspace</a> and open or create a project you will recognize by name.</li><li>Add the MCP address in your assistant using the steps below. Choose dynamic registration / OAuth when the host asks how to authenticate.</li><li>Approve Continuity, then ask the assistant to retrieve canon and the latest checkpoint before drafting.</li></ol>
</section>
<section><h2>1. ChatGPT and Codex</h2>
<p>The same server the ChatGPT/Codex plugin already uses. A public directory listing is not published yet, so connect it as a custom app.</p>
<ol><li>On workspace plans, an admin enables developer mode under Workspace settings → Permissions &amp; roles → Connected data developer mode / Create custom MCP connectors. Personal accounts that already offer custom apps can skip that toggle.</li><li>Open Apps → Create (workspace admins: Workspace settings → Apps → Create; other authorized users: Settings → Apps → Create).</li><li>Enter the MCP address, choose OAuth, scan tools, and approve the Continuity sign-in.</li><li>Enable the app in the conversation. Developer-mode apps are labeled Dev and are not OpenAI-verified.</li></ol>
<p>Codex can install the plugin package in <code>plugins/continuity</code> from a personal marketplace as <code>continuity@personal</code>, or use this same MCP address. Request includes <code>offline_access</code> when the host offers refresh; Continuity’s authorization server advertises that scope.</p>
</section>
<section><h2>2. Claude</h2>
<p>Claude.ai, Claude Desktop, Cowork, and the mobile apps use a remote connector. Claude’s servers call Continuity; you do not install a local plugin.</p>
<ol><li>Free, Pro, and Max: Customize → Connectors → Add custom connector. Team and Enterprise: an owner adds it under Organization settings → Connectors → Add → Custom → Web, then each member chooses Connect.</li><li>Name it Continuity and paste the MCP address.</li><li>Choose sign-in (OAuth). For the OAuth client, choose <strong>Register automatically</strong> (dynamic client registration). Leave client id and secret empty. Do not put a token in request headers.</li><li>Approve Continuity in the browser, then turn the connector on from the chat + menu → Connectors.</li></ol>
<p>Claude Code, from a terminal:</p>
<pre><code>claude mcp add --transport http continuity ${mcp}</code></pre>
<p>Do not pass <code>--header Authorization</code>. Claude Code opens the same OAuth flow. In a JSON config, set <code>"type": "http"</code> next to <code>url</code>.</p>
</section>
<section><h2>3. Gemini</h2>
<h3>Gemini Apps (supported, with Google’s eligibility limits)</h3>
<p>Google’s Gemini Apps help documents custom connected apps: add an MCP server URL in the Gemini web app. Google requires you to be 18 or older, in the US, signed in with a personal Google Account, with Keep Activity on. Work and school accounts cannot use this path. Custom apps are English-only. Connect on the web; the link then works in the Gemini mobile app too.</p>
<ol><li>On a computer, open gemini.google.com → Settings → Connected apps. If you do not see Connected apps, open Personal Intelligence → Connected apps first.</li><li>Under Custom apps, add a custom app and paste the MCP address.</li><li>Leave advanced credentials empty. Continuity supports dynamic client registration, so a client id is not required.</li><li>Finish Google’s sign-in, then type <code>@</code> and choose Continuity when you want that chat to use it.</li></ol>
<h3>Gemini CLI (supported)</h3>
<p>Gemini CLI can add a Streamable HTTP server and discover OAuth itself, including dynamic registration:</p>
<pre><code>gemini mcp add --transport http --scope user continuity ${mcp}</code></pre>
<p>That writes <code>~/.gemini/settings.json</code>. Do not set an Authorization header. If the CLI reports a missing issuer (<code>iss</code>) on the callback, Google is enforcing RFC 9207 and the authorization server did not return that parameter. Continuity cannot add it from this app. Use Gemini Apps, or another host, until that redirect includes <code>iss</code>.</p>
<h3>Not available yet</h3>
<ul><li><strong>Gemini API, including Gemini 3 in the Interactions API.</strong> Google’s Interactions API docs say Gemini 3 does not support remote MCP and that support is coming later. There is no Continuity function-calling schema to paste into AI Studio. A managed-agent <code>mcp_server</code> tool appears in Google’s agent materials without a Continuity OAuth sign-in; do not paste a Continuity access token into it.</li><li><strong>Gemini Enterprise custom MCP.</strong> The admin form (business.gemini.google, Add MCP server, OAuth 2.0) requires a client id and secret for an OAuth app whose redirect URL is <code>https://vertexaisearch.cloud.google.com/oauth-redirect</code>. Continuity does not publish that client. The public authorization and token URLs are on the Supabase issuer advertised at <code>/.well-known/oauth-protected-resource/mcp</code>, and the scopes are <code>email</code> and <code>offline_access</code>, but an owner has to register the Enterprise client in Supabase before that form can be saved.</li></ul>
</section>
<section><h2>4. Grok</h2>
<h3>Grok on the web</h3>
<ol><li>Open grok.com/connectors.</li><li>Choose New connector → Custom.</li><li>Paste the MCP address and finish the sign-in Grok presents.</li></ol>
<p>On Grok Business and Enterprise, an admin provisions connectors before members can use them. The server must be reachable on the public internet. Grok discovers the tools after you connect.</p>
<h3>Grok Build</h3>
<pre><code>grok mcp add --transport http continuity ${mcp}</code></pre>
<p>OAuth runs in the browser on first use. The equivalent user config is:</p>
<pre><code>[mcp_servers.continuity]
url = "${mcp}"</code></pre>
<p>in <code>~/.grok/config.toml</code>. Do not set an Authorization header. In the Grok Build UI, <code>/mcps</code> then <code>i</code> starts sign-in.</p>
<h3>xAI API</h3>
<p>The xAI API remote-MCP tool accepts a static <code>authorization</code> bearer token. Continuity does not issue API keys or long-lived tokens for that field. Use grok.com or Grok Build, which perform OAuth, instead of pasting a session token into an API request.</p>
</section>
<section><h2>5. Cursor and other MCP clients</h2>
<p>Cursor speaks remote Streamable HTTP with OAuth. In <code>~/.cursor/mcp.json</code> (all projects) or <code>.cursor/mcp.json</code> (one project):</p>
<pre><code>{
  "mcpServers": {
    "continuity": {
      "url": "${mcp}"
    }
  }
}</code></pre>
<p>Do not add <code>headers</code> or a static <code>auth</code> client id. Cursor registers a client and opens sign-in. Restart Cursor or enable the server under Customize → MCPs. A static OAuth client is only for servers that lack dynamic registration; Continuity has it, so registering Cursor’s redirect URLs by hand is unnecessary.</p>
<p>Any other MCP client uses the same address when it supports Streamable HTTP, OAuth 2.0 with PKCE, and dynamic client registration (RFC 7591). An unauthenticated call returns <code>401</code> with a <code>WWW-Authenticate</code> challenge pointing at <code>/.well-known/oauth-protected-resource/mcp</code>. Ask for the <code>email</code> scope. Add <code>offline_access</code> when the client can refresh tokens. Clients that call from their own servers should not send a browser <code>Origin</code>. Browser calls are accepted only from Continuity and the assistant sites listed in the server allowlist; other websites are rejected.</p>
</section>
<section><h2>After it connects</h2>
<p>“Use Continuity to resume my story <em>[project name]</em>. Retrieve its canon and latest checkpoint before drafting.”</p>
<p>“Keep concise checkpoints for this story when we finish a scene or pause. Keep unresolved ideas provisional, and ask before making new canon official.”</p>
<p><strong>Canon</strong> holds facts you approve. <strong>Approved scenes</strong> hold summaries of accepted scenes. <strong>Checkpoints</strong> preserve story progress, open questions, and next steps separately from canon.</p>
<p>The assistant calls tools only when you and the host allow it. Continuity cannot watch every chat, run while the assistant is idle, or guarantee a save before context loss. Ask to save a checkpoint before switching chats. Disconnecting an application stops future access; it does not delete stories or cancel billing.</p>
</section>`;
}
