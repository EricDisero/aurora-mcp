# aurora-mcp

MCP server + CLI + skills package for **Aurora**, the AI audio workbench — drive music generation, style-transform covers, sample manufacturing, 7-stem separation, and DAW-ready stem organization from Claude Code, Cursor, Claude Desktop, or any MCP-capable client.

This monorepo publishes two installable packages, plus their shared core:

- **`@ericdisero/aurora-mcp-server`** — stdio MCP server. Run with `npx -y @ericdisero/aurora-mcp-server`.
- **`@ericdisero/aurora-cli`** — `aurora` binary. Run with `npm i -g @ericdisero/aurora-cli`.
- **`@ericdisero/aurora-shared`** — the operations layer both surfaces depend on.

## What it does

The MCP/CLI gives an AI agent full control of an Aurora music library: create projects, generate full tracks (Suno), transform existing audio into new styles (covers with the `audioWeight` dial), manufacture key/tempo-locked samples and one-shots, split ANY audio into 7 stems (vocals, kick, snare, toms, hats, bass, everything-else via MVSEP + local phase cancellation). **31 tools.** Files on disk are the product — everything lands in real project folders the Aurora desktop app shows live.

Standalone by design: the server works directly against Aurora's database and project folders. The desktop app does not need to be running (mastering — analyze/mix/export — stays in the app window for now).

## Setup

1. Configure provider keys (once):
   ```bash
   npm i -g @ericdisero/aurora-cli
   aurora keys --suno-api-key <key> --mvsep-api-key <key>
   ```
   (or skip the CLI and pass keys via the MCP config `env` block)
2. Add to your MCP config:
   ```json
   {
     "mcpServers": {
       "aurora": {
         "command": "npx",
         "args": ["-y", "@ericdisero/aurora-mcp-server"]
       }
     }
   }
   ```
   Claude Code one-liner: `claude mcp add aurora -- npx -y @ericdisero/aurora-mcp-server`

## Using it

### CLI (Claude Code, terminal scripts)

```bash
aurora status                 # where Aurora's data lives + key state
aurora install-skills         # bundled agent recipes → ./.claude/skills/<name>/SKILL.md
aurora mcp                    # print (or copy) the MCP client config
aurora run --list             # list every operation
aurora run aurora_create_project --name "Midnight Drive"
aurora run aurora_sounds --prompt "huge cinematic braam, dark low brass" --soundKey Cm --tempo 140
aurora run aurora_split --assetId <id> --background
aurora run aurora_get_job_status --jobId spl-xxxx
```

### Long jobs + streaming preview

Generation (1-3 min) and splits (3-5+ min) support `background: true` → poll `aurora_get_job_status`. While a generation is cooking, status includes **streamUrls — listenable ~30-45s in, minutes before the files land.** Split stems land progressively as each MVSEP job finishes. Jobs survive restarts (provider-side state in `userData/agent-jobs/`).

## Architecture

```
~/.aurora/config.json          ← provider keys (or env vars; env wins)
<userData>/aurora.db           ← Aurora's own SQLite library (WAL — app + agent coexist)
<userData>/projects/<slug>/    ← generations/ covers/ imports/ references/ stems/ masters/
<userData>/agent-jobs/         ← background-job manifests

@ericdisero/aurora-shared      ← operations/index.ts (single tool surface), storage,
                                  Suno + MVSEP clients, jobs, split, ffmpeg
@ericdisero/aurora-mcp-server  ← stdio server, registers operations as MCP tools
@ericdisero/aurora-cli         ← commander entry: run / install-skills / keys / status / mcp
```

## Publishing

Publish order matters: shared → mcp-server → cli (both depend on shared at an exact version). Always from the repo root:

```bash
npm run publish:all
```

## License

MIT. Copyright Blueprint Online Learning Inc.
