# Continuity

Continuity is a private story bible for fiction. It keeps characters, relationships, world rules, timelines, and approved scenes, then lets an assistant read that canon before it writes.

It works with ChatGPT, Claude, Gemini, Grok, and Cursor, plus any other MCP client that can do Streamable HTTP and OAuth. It is not a ChatGPT-only plugin.

- Site: https://continuitywriter.com
- Setup: https://continuitywriter.com/connect
- MCP address: `https://continuitywriter.com/mcp`

Sign in with your Continuity account when the assistant opens OAuth. Do not paste an API key or password into a header. Story tools need Pro or an active trial. The site offers a 14-day trial. The live pricing page does not print a dollar amount, so this page does not invent one.

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
