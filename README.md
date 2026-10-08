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

Registry metadata for this remote server is in `server.json` (`io.github.LAHutchins91/continuity`).

This repo is also a Cursor plugin: `.cursor-plugin/plugin.json` plus `mcp.json` at the root, with the `story-bible` skill in `skills/`.

---

More from Ouroboros: https://ouroborosapps.com
