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

## Permissions, data, and limits

**OAuth scope.** Sign-in is OAuth 2.1 with dynamic client registration and PKCE. The scopes are `email` and `offline_access` (refresh tokens). A token reaches only the signed-in user's own story projects; database ownership rules keep one account from reading another's projects.

**Read operations.** `list_story_projects`, `get_continuity_context`, `search_story_canon`, `get_canon_history`, `list_approved_scenes`, `list_story_checkpoints`, and `continuity_audit` only read (`readOnlyHint: true`).

**Write operations.** `create_story_project` creates a project. `save_story_checkpoint` saves a provisional session note. `upsert_canon_entry` creates or revises a canon entry, and `record_approved_scene` saves an approved scene summary. The last two are marked `destructiveHint: true` because they can replace saved text.

**Delete operations.** No MCP tool deletes anything. Projects are exported or deleted by the user in the Continuity workspace at https://continuitywriter.com.

**Confirmations and safeguards.** Tool descriptions tell the assistant to save canon and scenes only after the user approves them; brainstorming is not approval. The destructive hints let hosts ask before running those two tools. A canon revision must send the `expectedRevision` it read, so a stale edit fails instead of overwriting, and every revision is kept in `get_canon_history`. An occupied scene number is kept unless `replaceExisting` is true and the user asked for the replacement. Identical retries of the canon, scene, and checkpoint tools do not create duplicates.

**Data stored.** Account id and sign-in email, subscription status and Stripe references, and the story content the user saves: projects, canon entries and their revisions, approved scene summaries, and provisional checkpoints. Tools receive only their own arguments; Continuity does not receive whole conversations. Supabase hosts authentication and the database, Vercel hosts the server, and Stripe handles payments (Continuity never stores full card numbers).

**Retention and privacy.** Saved stories stay until the user deletes the project or asks for account deletion. Deleting a project removes its live canon, revisions, scenes, and checkpoints; provider backups follow the provider's retention schedule. Story content is not sold and is not used to train models. Full policy: https://continuitywriter.com/privacy

**Free limits.** Tool discovery (`initialize`, `tools/list`) is open. Story tools need a Continuity account with a 14-day trial, then a monthly or yearly subscription through Stripe Checkout. Stripe shows the amount; this repository does not list one. Text fields are capped (canon content 12,000 characters, checkpoint state 6,000) and list tools page 50 rows at a time.

**How it is used.** A writer creates a project, approves character, place, and timeline facts as canon, and records each approved scene. In a new chat, the assistant calls `get_continuity_context` to pick up where the story left off, and runs `continuity_audit` on a draft scene to catch contradictions with locked canon before the writer accepts it.

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
