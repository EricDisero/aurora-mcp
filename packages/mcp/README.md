# @ericdisero/aurora-mcp-server

Stdio MCP server for Aurora's local audio library. Agents generate Suno music/covers/sounds, organize projects/tracks/assets, split seven stems, extract instrument groups and inspect checked results. The server works directly on Aurora's SQLite database and project folders; the desktop app need not be running. Live Mix/Export app control is out of scope for now.

The complete tool surface comes from [`ALL_OPERATIONS`](../shared/src/operations/index.ts), exposed by MCP `tools/list`. See the [repository README](../../README.md) for the current counts and CLI workflow.

## Setup

Node.js 18 or newer:

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

To run a local checkout instead, build it and use `command: "node"` with `args: ["<absolute checkout path>/packages/mcp/dist/server.js"]`.

Environment variables override `~/.aurora/config.json`. Alternatively configure keys with the sibling CLI: `aurora keys --suno-api-key <key> --mvsep-api-key <key>`. `KIE_API_KEY` is the fallback Suno provider key. Local library reads, routes and checks need no keys.

## Separation workflow

1. Discover routes with `aurora_list_separation_routes`. Filter `surface: "extract group"` for whole groups; route data includes exact options/output keys, checks, measured quality and evidence. The extract schema derives selectable stems from the catalog.
2. Plan with `aurora_split` or `aurora_extract` and `estimateOnly: true`. This is free and returns the exact call topology and duration-based provider units.
3. After authorizing spend, start split/extract once. Both default to `background: true`, saving a queued manifest before any submission. Splits deliver vocals, kick, snare, toms, hats, bass and Other; extraction supports groups, instruments, vocal modes and dereverb, sharing bundled calls where possible.
4. Call `aurora_get_job_status` with the returned `jobId` and optional `waitSeconds` (0-30). Default `advance: true` can submit paid calls and land files. With 0 it advances once; a positive value bounds waiting between units, while an in-flight interaction settles. Use `advance: false` or `aurora_list_jobs` for free local snapshots.
5. Inspect terminal status and `aurora_check_separation_result` before replacement paid work. `completed`, `partial`, `failed` and `cancelled` are terminal; active states are `queued`, `submitting`, `waiting` and `landing`. Failed/partial tool results set `isError: true` while retaining outputs and structured diagnostics.

The connection advances only jobs explicitly started/resumed through it. Closing stops future units; manifests survive in `<userData>/agent-jobs/`. After reconnecting, resume with status. Summaries retain per-route `splitAttempts`/`callResults`, requested/delivered files, detected key and `lastError`. Suno operations support background jobs but default to blocking; their initial call submits paid work. Available `streamUrls` are expiring previews, and results are downloaded to disk.

`aurora_cancel_job` saves cancellation intent and stops subsequent submissions, polls and landings. An interaction in progress settles; accepted provider work may still run and is not refunded. Saved files stay.

## Checked before saving

Every separation result uses exact output identity and audio checks before files receive stem names. Unique upload names prevent shared-result collisions; algorithm/type metadata is cross-checked when available. Missing, duplicate or contradictory outputs fail. Temporary downloads must pass audio shape, finite-sample, route-sum and applicable family checks before landing. Failed checks remove those downloads and report the cause; successful sibling routes stay.

Family tests cover drums/percussion, bass and vocals/choir. Brass, woodwinds, strings, keys and guitar rely on identity/sums and cannot detect every clean swap. A pass is not proof of musical purity; inspect route quality and evidence.

`aurora_check_separation_result` accepts either `jobId` alone or `routeId` + `inputPath` + `outputs` (exact output keys to local WAV paths, including auxiliary checking outputs). It returns `ok`, problems, notes, metrics, checked window and limitations. A job check distinguishes fresh `verification: "replayed"` from `"recorded"` provenance when auxiliary files are unavailable. A completed local check returns its verdict even when `ok: false`.

## Costs and free checks

Suno generation/cover/layering/editing and provider WAV conversion spend credits. MVSEP submissions spend premium minutes per planned call; advancing a queued job can spend. Plans, route discovery, local result checks, job snapshots/cancellation and local library/audio work are free. Other is computed locally. `aurora_get_credits` reads provider balances without spending; extract estimates label future Aurora metering separately from provider units. Existing active splits or seven valid stems are reused. Asset/project deletion requires `confirm: true`.

From the repository root, with dependencies installed:

```bash
npm run build
npm run typecheck
npm run smoke
npm run test:contract
npm run test:surface
```

These tests use isolated libraries/offline fixtures with no paid calls. Typecheck checks generated app mirrors, builds shared and checks every package; the app checkout must be adjacent or supplied through `AURORA_REPO`.

MIT. Copyright Blueprint Online Learning Inc.
