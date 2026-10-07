# aurora-mcp

MCP server, CLI and agent skills for Aurora, the AI audio workbench. Agents generate music, organize the local library, split audio into seven stems and extract selected instrument groups. Files land in the project folders shared with the desktop app through SQLite and disk; the app does not need to be running.

Version **0.6.1**: **55 tools** and **5 skills**. The complete tool surface, parameters, defaults and effects live in [`ALL_OPERATIONS`](packages/shared/src/operations/index.ts), available through MCP `tools/list` or `aurora run --list`.

## What agents can do

- Generate tracks, covers, sounds and vocal/instrumental layers through Suno; extend, replace sections and mash up source audio.
- Create projects and tracks, import audio and references, move assets between tracks and mark favorites.
- Inspect and copy asset/stem recipes, reload prompts or source references in the desktop composer, and plan variations free before confirming paid calls.
- Read separate split, extraction, imported and custom stem sets; register completed bridge split jobs or hand-made sets without copying files or spending.
- Split an asset into vocals, kick, snare, toms, hats, bass and Other using three measured MVSEP routes plus local phase cancellation. Checked stems land progressively as each route finishes.
- Extract whole groups, individual instruments and vocal modes. Group ids come from [`GROUP_ROUTES`](packages/shared/src/separation/routes.ts); discover them with `aurora_list_separation_routes` using `surface: "extract group"`. Extraction shares bundled calls and builds Other locally.
- Discover route quality/evidence, plan without spending, inspect separation checks, resume jobs and cancel future work. Convert or pitch-shift files locally; RVC/MIDI sidecars require the Aurora repo and their Python dependencies.
- Read the exact beat grid of any audio file with `aurora_beat_grid` (Beat This!, ISMIR 2024): tempo from a least-squares fit over every beat, beats, downbeats, meter, first downbeat, the constant-tempo residual and the offset to the kick transients. Free and local; needs the one-time Python environment described below.

Mix, mastering and Export remain interactive desktop flows. An app-control bridge for agents driving the live Mix/Export is deliberately out of scope for now.

## Setup

Node.js 18 or newer is required. The installable packages are `@ericdisero/aurora-mcp-server` (stdio server), `@ericdisero/aurora-cli` (`aurora` binary) and their shared core, `@ericdisero/aurora-shared`.

Configure keys through environment variables (`SUNO_API_KEY`, or fallback `KIE_API_KEY`, and `MVSEP_API_KEY`) or the CLI:

```bash
npm i -g @ericdisero/aurora-cli
aurora keys --suno-api-key <key> --mvsep-api-key <key>
aurora status
```

`aurora keys` stores configuration in `~/.aurora/config.json`; environment variables take precedence. Local library reads, route discovery and checks need no provider keys.

For the MCP server, add this to your client's configuration:

```json
{
  "mcpServers": {
    "aurora": {
      "command": "npx",
      "args": ["-y", "@ericdisero/aurora-mcp-server"],
      "env": {
        "SUNO_API_KEY": "<your key>",
        "MVSEP_API_KEY": "<your key>"
      }
    }
  }
}
```

The `env` block is optional when keys are saved through `aurora keys`. To run a local checkout instead, build it and configure `command: "node"` with `args: ["<absolute checkout path>/packages/mcp/dist/server.js"]`; for its CLI, replace `aurora` in the examples below with `node packages/cli/dist/index.js`.

## Plan, start, status, check

```bash
aurora run --list
aurora install-skills
aurora run aurora_list_separation_routes --surface "extract group"
aurora run aurora_split --assetId <id> --estimateOnly true --json
aurora run aurora_extract --assetId <id> --stems brass,strings --estimateOnly true --json
```

After authorizing the plan's provider spend, start one separation job and keep its returned `jobId`:

```bash
aurora run aurora_extract --assetId <id> --stems brass,strings --json
aurora run aurora_get_job_status --jobId <job-id> --waitSeconds 30 --json
aurora run aurora_check_separation_result --jobId <job-id> --json
```

Split and extract default to `background: true`: starting saves a queued manifest before submission. Status defaults to `advance: true`, which can submit the next paid call, poll results and land checked files. `waitSeconds` is 0-30; 0 advances once, while a positive value waits between engine units up to that budget. An interaction already in progress settles before the call stops, so this is not a hard network deadline.

The MCP connection advances only jobs explicitly started or resumed through that connection. On reconnect, call status to resume. CLI callers must keep calling status themselves; the CLI leaves no worker behind. Suno operations support `background: true` but default to blocking, and their initial call submits paid generation immediately. Available `streamUrls` are expiring previews; downloaded files are the durable outputs.

Other (`other`) is the track minus every stem pulled out in that split. New files use `other.wav`. Stem inputs still accept `ee` as a deprecated alias; persisted job ids are normalized when read, while existing file paths stay unchanged.

Jobs move through `queued`, `submitting`, `waiting` and `landing` to `completed`, `partial`, `failed` or `cancelled`. Manifests survive restarts in `<userData>/agent-jobs/`. A partial result retains successful files and diagnostics. Inspect `splitAttempts` or `callResults`, `requestedStemIds`, `extractedFiles`, `detectedKey` and `lastError` before starting replacement work. Failed/partial MCP results set `isError: true` and retain structured output; CLI `--json` exposes the same data under `data`.

For snapshots or cancellation:

```bash
aurora run aurora_get_job_status --jobId <job-id> --advance false --json
aurora run aurora_list_jobs --json
aurora run aurora_cancel_job --jobId <job-id> --json
```

Cancellation saves local intent and stops subsequent submission, polling and landing units. An interaction already in progress settles; submitted provider work may still run and is not refunded. Saved outputs stay.

## Separation checks

Every provider separation result is checked before it is saved as a stem. Each job uses a unique upload name. The runner resolves **exact output keys**, cross-checks provider algorithm/type metadata when available, and rejects missing, duplicate or contradictory files. It then downloads to temporary names and checks audio shape, finite samples, route sums and applicable family tests. A failed identity/content check removes the temporary downloads and reports the reason without saving that route's stems.

Drums/percussion, bass and vocals/choir have family checks. Brass, woodwinds, strings, keys and guitar rely on identity and sum checks; a clean label swap in those families can pass. A check pass is not proof of musical purity. Route discovery exposes `quality` and `evidence` before spending, including rough or untested routes.

`aurora_check_separation_result` is free and local. Supply `jobId` for saved provenance and replay where possible, or `routeId`, `inputPath` and `outputs` (exact output key to local WAV path, including auxiliary checking files). Read `ok`, `problems`, `metrics`, `checkWindowSeconds` and `limitations`. Job checks explicitly report `verification: "recorded"` when discarded auxiliary outputs prevent a fresh replay; otherwise they report `"replayed"`. A completed local check can return `ok: false` without being a tool execution error.

## Credits and local work

Suno generation, covers, layering, editing and provider WAV conversion spend credits. MVSEP submissions spend premium minutes per planned call. Separation status advancement may initiate that spend; queuing alone does not. Split/extract `estimateOnly: true` returns exact routes/options and duration-based provider units without submitting. The extract estimate's Aurora `credits` field is future metering, not a current provider price.

Route discovery, local checks, job snapshots/cancellation, library operations and local audio processing do not spend provider credits. `aurora_get_credits` is a free network balance read. Existing active split work or seven valid stems are reused without another submission. Deleting assets/projects or stored stem-set rows requires `confirm: true`.

## Beat grid

```bash
python <aurora checkout>/sidecar-beats/setup_venv.py   # once: ~/.venvs/aurora-beats, torch + Beat This! + weights (CPU; --cuda for GPU)
aurora run aurora_beat_grid --path <audio file> --bpmHint 120 --json
```

`aurora_beat_grid` takes an `assetId` or an absolute `path` and any format the bundled ffmpeg reads. `bpm` is a least-squares line through every beat (the model's own beats sit on a 20 ms frame grid, so `bpmMedian` reads coarser); `fit.rmsMs` says how constant that tempo is, `kick.gridMedianOffsetMs` how far the grid sits from the kick transients (use it only when `kick.reliable`), and `hint` compares the result with the tempo you expected without changing it. The op finds the environment at `~/.venvs/aurora-beats` (`AURORA_BEATS_PYTHON` overrides) and the script in the app checkout beside this repo or at `AURORA_REPO`. Without the environment it fails with `ENGINE_NOT_INSTALLED` and the setup command.

## Development and free tests

With dependencies installed, run from the repo root:

```bash
npm run build
npm run typecheck
npm run smoke
npm run test:contract
npm run test:surface
npm run test:stem-sets
npm run test:recipes
npm run test:beat-grid
```

The tests use isolated libraries and offline fixtures; no Suno/MVSEP spend. `npm run typecheck` checks mirror drift, builds shared declarations and checks MCP/CLI. It needs the Aurora app checkout beside this repo, or `AURORA_REPO` pointing to it.

[`separation/*.ts`](packages/shared/src/separation) and [`extract-catalog.ts`](packages/shared/src/extract-catalog.ts) are generated app mirrors. Edit the app, then run `node scripts/sync-separation.mjs`; never edit the mirrors. `node scripts/sync-separation.mjs --check` is read-only. For manual write tests, set `AURORA_USER_DATA` to an isolated test directory. `aurora status` reports the actual data and projects paths; the app's custom projects-directory setting is respected.

## License

MIT. Copyright Blueprint Online Learning Inc.
