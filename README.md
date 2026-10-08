# Continuity

Continuity keeps your project facts across chats. It's a story bible for fiction writers: your characters, places, timelines and plot facts stay consistent while you write in ChatGPT, Claude, Grok or Cursor.

It also works with Gemini and any other MCP client that supports Streamable HTTP and OAuth. Made by Ouroboros (https://ouroborosapps.com).

- Site: https://continuitywriter.com
- Setup: https://continuitywriter.com/connect
- Docs: https://ouroborosapps.com/docs/continuity
- MCP address: `https://continuitywriter.com/mcp`
- Logo: https://continuitywriter.com/logo.jpg

Sign in with your Continuity account when the assistant opens OAuth. Do not paste an API key or password into a header. Story tools need an active Continuity account; see https://continuitywriter.com for details.

## What the assistant can do

After you approve the connection, the server exposes these tools:

- list_story_projects
- create_story_project
- get_continuity_context
- search_story_canon
- upsert_canon_entry
- get_canon_history
- list_approved_scenes
- record_approved_scene
- save_story_checkpoint
- list_story_checkpoints
- continuity_audit

Locked facts stay locked until you revise them. Checkpoints are provisional and are not canon. The assistant only calls these tools when you and the host allow it.

## Connect

Cursor, in `~/.cursor/mcp.json` or a project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "continuity": {
      "url": "https://continuitywriter.com/mcp"
    }
  }
}
```

Claude Code:

```bash
claude mcp add --transport http continuity https://continuitywriter.com/mcp
```

Other clients: add the same URL, choose OAuth, and leave client id and secret empty. Continuity supports dynamic client registration. Full steps for each assistant are on the connect page.

Grok Build: install the `ouroboros-continuity` plugin from the plugin marketplace, then sign in when the browser opens.

Registry metadata for this remote server is in `server.json` (`io.github.LAHutchins91/continuity`).

## Plugin contents

This repo is a plugin for Grok Build and Cursor, published by Ouroboros Apps:

- Grok Build: `.grok-plugin/plugin.json` plus `.mcp.json`
- Cursor: `.cursor-plugin/plugin.json` plus `mcp.json`
- One skill: `skills/story-bible/SKILL.md` (instructions only, no scripts)
- One remote MCP server, `continuity`, over Streamable HTTP

The plugin has no hooks, commands, agents, or LSP servers, and it runs no code on your machine. The `src/` folder and `Dockerfile` are MCP server source, published for reference and registry container checks. When someone runs that code as a server, it reads its own server settings (database and billing keys) from that server's environment. The plugin does not build, install, or run it, and nothing in this repo runs on install (no `postinstall` or other lifecycle scripts).

## Network endpoints and credentials

- `https://continuitywriter.com/mcp` is the only MCP endpoint. Story tools read and write the story projects in your own Continuity account.
- Sign-in uses OAuth 2.1 with dynamic client registration. Protected resource metadata is at `https://continuitywriter.com/.well-known/oauth-protected-resource`. The authorization server it lists is Continuity's account service, hosted on Supabase (`https://kufinkiktgnnhusuenjq.supabase.co/auth/v1`). Your browser opens it when you sign in.
- Credentials: your Continuity account, through that browser sign-in. The plugin needs no API key, environment variables, or local files, and it does not read any.
- Requests without a valid token get `401 Unauthorized`.
- Privacy: https://continuitywriter.com/privacy. Support: https://continuitywriter.com/support. Contact: ouroborosplugins@gmail.com.

---

More from Ouroboros: https://ouroborosapps.com
