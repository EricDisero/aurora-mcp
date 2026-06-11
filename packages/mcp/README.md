# @ericdisero/aurora-mcp-server

Stdio MCP server for **Aurora**, the AI audio workbench. Gives Claude (or any MCP client) full control of a local music library: generate tracks, style-transform covers, manufacture key/tempo-locked samples, split anything into 7 stems, layer the stack, export DAW-ready aligned WAVs. **27 tools.** Files land on disk in real project folders the Aurora app shows live.

## Install

```json
{
  "mcpServers": {
    "aurora": {
      "command": "npx",
      "args": ["-y", "@ericdisero/aurora-mcp-server"],
      "env": {
        "SUNO_API_KEY": "<your sunoapi.org key>",
        "MVSEP_API_KEY": "<your mvsep key>"
      }
    }
  }
}
```

Claude Code: `claude mcp add aurora -- npx -y @ericdisero/aurora-mcp-server`

The `env` block is optional if keys are stored via the CLI (`aurora keys --suno-api-key … --mvsep-api-key …` → `~/.aurora/config.json`).

## Highlights

- **Standalone** — works against Aurora's database + project folders directly; the desktop app doesn't need to be running.
- **Background jobs** — `background: true` on generate/cover/sounds/split returns a jobId; `aurora_get_job_status` polls, downloads, and registers results. Jobs survive restarts.
- **Streaming preview** — in-flight generations expose `streamUrls`: listenable ~30-45s in, minutes before files land.
- **Progressive stems** — splits land vocals/drums/bass stems as each separation job finishes; everything-else last.
- **Cost discipline built in** — `aurora_get_credits` is free; destructive ops require `confirm: true`; re-splitting an already-split asset is refused.

Full docs: [github.com/EricDisero/aurora-mcp](https://github.com/EricDisero/aurora-mcp). CLI sibling: `@ericdisero/aurora-cli`.

MIT. Copyright Blueprint Online Learning Inc.
