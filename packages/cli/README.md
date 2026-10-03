# @ericdisero/aurora-cli

`aurora` is the terminal interface to Aurora's audio library: Suno generation, covers and sounds, projects/tracks/assets, checked seven-stem splits and group/instrument extraction. It uses the same [`ALL_OPERATIONS`](../shared/src/operations/index.ts) registry as the MCP server. `aurora run --list` prints the current operations; their input schemas are the parameter reference.

## Setup and commands

```bash
npm i -g @ericdisero/aurora-cli
aurora keys --suno-api-key <key> --mvsep-api-key <key>
aurora status
aurora run --list
aurora run <op> --key value --json
aurora install-skills
aurora mcp
```

Node.js 18 or newer is required. Keys are saved in `~/.aurora/config.json`; `SUNO_API_KEY` (or fallback `KIE_API_KEY`) and `MVSEP_API_KEY` override saved values. `aurora keys` shows masked status. Local reads, route discovery and checks need no keys. `install-skills` writes the bundled recipes to `.claude/skills/<name>/SKILL.md`; `--global` installs under the home directory. `mcp` prints client configuration.

The command is `aurora run`, and `--help` on a run line gives generic dispatcher help. Use the registry's input schema for exact parameters. Booleans accept `--estimateOnly true`; arrays accept comma-separated values. `--json` returns `{text, data}`.

## Plan and run separation

```bash
aurora run aurora_list_separation_routes --surface "extract group" --json
aurora run aurora_split --assetId <id> --estimateOnly true --json
aurora run aurora_extract --assetId <id> --stems brass,strings --estimateOnly true --json
```

Routes expose quality/evidence and exact output keys. Plans spend nothing. After authorizing the provider spend, start once and advance the returned job:

```bash
aurora run aurora_extract --assetId <id> --stems brass,strings --json
aurora run aurora_get_job_status --jobId <job-id> --waitSeconds 30 --json
aurora run aurora_check_separation_result --jobId <job-id> --json
```

Split/extract default to background and queue before submitting. **The CLI leaves no worker running:** repeat status until `completed`, `partial`, `failed` or `cancelled`. Status defaults to `advance: true` and can submit paid calls. `waitSeconds` is 0-30; 0 advances once and positive values bound waiting between units. In-flight interactions settle before stopping. Suno operations default to blocking and accept `--background true`; their initial call spends immediately.

Snapshots and cancellation are local:

```bash
aurora run aurora_get_job_status --jobId <job-id> --advance false --json
aurora run aurora_list_jobs --json
aurora run aurora_cancel_job --jobId <job-id> --json
```

Manifests survive restarts; resume with status. Partial jobs keep successful outputs. Inspect `splitAttempts`/`callResults`, requested/delivered files and `lastError` in `data` before authorizing replacement work. Cancellation stops future units after an in-progress interaction settles. Accepted provider work may still run without a refund; saved files stay.

## Checks, costs and tests

Every provider separation result passes exact-key identity, audio-shape, sum and applicable family checks before being saved as a stem. Failed checks remove temporary downloads and report the reason. Local checks expose `ok`, metrics and limitations; job checks distinguish recorded provenance from a fresh replay when auxiliary files are unavailable. A pass does not certify musical purity, and brass/woodwinds/strings/keys/guitar have no family test for clean label swaps.

Suno generation/cover/layering/editing/WAV conversion and MVSEP submissions spend provider credits/minutes. Plans, route discovery, checks, snapshots/cancellation and local library/audio operations are free. See the [repository README](../../README.md) for the full workflow, check inputs and free test commands (`npm run smoke`, `npm run test:contract`, `npm run test:surface`, after build/typecheck).

Server sibling: `@ericdisero/aurora-mcp-server`. Live Mix/Export app control is out of scope.

MIT. Copyright Blueprint Online Learning Inc.
