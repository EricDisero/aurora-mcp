# @ericdisero/aurora-cli

`aurora` — terminal CLI for **Aurora**, the AI audio workbench. Drive music generation, covers, sample manufacturing, and 7-stem separation from your shell, or let Claude Code shell out to it instead of loading 31 MCP tool schemas into context.

## Install

```bash
npm i -g @ericdisero/aurora-cli
aurora keys --suno-api-key <key> --mvsep-api-key <key>   # once
aurora status
```

## Commands

```bash
aurora run --list                 # every operation + description
aurora run <op> --key value       # run any operation (same surface as the MCP)
aurora install-skills [--global]  # bundled agent recipes → .claude/skills/<name>/SKILL.md
aurora mcp                        # print the MCP client config for this machine
aurora keys                       # provider key status (masked)
aurora status                     # userData / database / projects root / keys
```

## Examples

```bash
aurora run aurora_create_project --name "Midnight Drive"
aurora run aurora_sounds --prompt "huge cinematic braam, dark low brass" --soundKey Cm --tempo 140
aurora run aurora_generate --prompt "dark synthwave, driving bass" --background
aurora run aurora_get_job_status --jobId gen-xxxx        # streamUrls while cooking
aurora run aurora_split --assetId <id> --background      # 7 stems, progressive landing
```

Server sibling: `@ericdisero/aurora-mcp-server`. Full docs: [github.com/EricDisero/aurora-mcp](https://github.com/EricDisero/aurora-mcp).

MIT. Copyright Blueprint Online Learning Inc.
