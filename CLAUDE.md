# aurora-mcp — Claude code notes

MCP server + CLI + skills for Aurora at `C:\Coding Projects\aurora\aurora`. Storage and provider operations share disk + SQLite (WAL); live view tools use the app's authenticated loopback bridge.

## Layout

```
aurora-mcp/
├── package.json                ← npm workspaces root (build / typecheck / publish:all)
├── smithery.yaml               ← Smithery registry config (stdio via npx) — NOT submitted yet
├── scripts/sync-separation.mjs ← app → generated separation mirrors; --check detects drift
├── scripts/{smoke-mcp,test-mcp-contract}.mjs ← free isolated protocol/audio tests
└── packages/
    ├── shared/                 ← @ericdisero/aurora-shared
    │   skills/*.md             ← bundled agent recipes (single source)
    │   scripts/embed-skills.mjs← prebuild: skills/*.md → src/skills/content.ts (generated)
    │   src/
    │     paths.ts              ← userData/settings/projects-root resolution sans Electron
    │     config.ts             ← provider keys: env > ~/.aurora/config.json
    │     db.ts                 ← better-sqlite3, KNOWN_SCHEMA_VERSION (lockstep w/ app)
    │     storage/*.ts          ← ports of aurora src/main/storage
    │     providers/{suno,mvsep}.ts ← provider clients (+ single-shot poll fetchers)
    │     separation/*.ts       ← GENERATED app routes, identity/content checks, runner, contracts/catalog
    │     extract-catalog.ts    ← GENERATED app extraction catalog, planned calls carry routeId
    │     {split,extract}.ts    ← durable orchestration using the generated checked routes
    │     separation-tools.ts   ← free route discovery, provenance and local checks
    │     jobs.ts               ← background-job manifests (userData/agent-jobs/)
    │     sidecars.ts           ← RVC/MIDI python spawns (need AURORA_REPO env)
    │     audio/{ffmpeg,wav}.ts ← @ffmpeg-installer ops + RIFF codec (port)
    │     operations/index.ts   ← ALL_OPERATIONS: single source of truth for tool surface
    ├── mcp/                    ← @ericdisero/aurora-mcp-server (bin: aurora-mcp-server)
    └── cli/                    ← @ericdisero/aurora-cli (bin: aurora)
        src/commands/{op,install-skills,keys,status,mcp}.ts
```

## Hard rules

- **Never duplicate operation logic.** Both surfaces register the same `ALL_OPERATIONS` array. New tool = one edit in `packages/shared/src/operations/index.ts`.
- **Op schemas expose the FULL wire surface with sane defaults — curation is the app's job, never the MCP's** (locked 2026-06-10; the agent layer ships with MORE control than the app, never less). Param contract for the Suno ops: `docs/suno-param-surface.md`.
- **Schema lockstep with the aurora app.** `db.ts` mirrors `aurora/src/main/database/migrations.ts` through v7 (v6: leftover stem id `other`, WAV paths unchanged; v7: stored `stem_sets` and `stem_lanes`). `KNOWN_SCHEMA_VERSION` refuses newer DBs. Port every new app migration here in the same session and bump that constant.
- **Storage-semantics lockstep.** `storage/*.ts` ports the app's modules; behavior changes go into BOTH codebases or neither. Split/extract orchestration consumes the app's generated separation contract (table below).
- **Never edit separation mirrors.** `packages/shared/src/separation/*.ts` and `extract-catalog.ts` are GENERATED from the app by `scripts/sync-separation.mjs` (with ESM import adaptation/provider-interface extraction). Fix the app, then resync. `--check` runs in `npm run typecheck`; drift fails the check.
- **Check before landing.** Use canonical exact-key resolution and route content checks, never substring/list-order matching. Every submission uses a unique upload name. Failed identity/content checks save no stems for that route. A check pass is not proof of musical purity; report family/replay limits.
- **Persist before spending.** Split integration uses `startSplitJob(assetId)` then `advanceJob`; untracked `createSplitJobs` is refused. Split/extract default to queued background jobs. Status defaults to advancement and can spend; `advance:false` and `list_jobs` are local snapshots. MCP advances only jobs started/resumed through its connection; CLI callers advance explicitly. Cancellation stops subsequent units after any in-flight interaction settles; accepted provider work may still run without refund.
- **Provider URLs expire server-side.** Always download-and-persist; `streamUrls` are preview-only, never stored as asset paths.
- **NEVER throw a provider failure as status-only.** `GENERATE_AUDIO_FAILED` hides distinct causes. Parse `record-info`'s `errorCode` + `errorMessage` at EVERY throw site (`generationFailureDetail()` in `providers/suno.ts`; app mirror in `suno-client.ts`).
- **Cover-of-a-Suno-track does not work by re-upload.** Upload-cover/extend/mashup/replace-section can reject Suno output with `errorCode 413` (existing catalog recording). Iterate with `taskId`/`audioId` routes; extend/replace_section select them when source assets carry provider ids. `cover-suno` is cover ART. Findings/scope: `docs/suno-param-surface.md`.
- **Re-verify live docs before declaring a param absent.** Param reference: `docs/suno-param-surface.md`. **Model enum + default live ONLY in `providers/suno.ts` (`SUNO_MODELS`, `DEFAULT_SUNO_MODEL`, `normalizeModel`)**; ops/docs reference it, never restate it.
- **Destructive ops require `confirm: true`** (delete_asset, delete_project). Splits reuse active work or seven valid distinct stems without re-spending.
- Each chat commits and pushes its own finished work, staged by name, under the vault's CLAUDE.md rule 2.

## Op ↔ source-module contract table

Storage/provider ports follow these app sources; agent jobs and surface adapters are local extensions.

| Op | Source / adapter contract |
|---|---|
| aurora_get_view / set_view | App `src/main/agent/{server,auth,view,protocol}.ts` + renderer `agent/{actions,view,selection}.ts`; `clients/desktop.ts` discovers `~/.aurora/agent-connection.json`, checks protocol/capabilities and sends requestId + optional expectedRevision. Renderer acknowledgements: applied, partial, rejected, uncertain. Timeout never confirms application. Duplicate ids return the first result per app process; reads return null when disconnected. Verify mode publishes inside its profile, exposed by `agentConnectionPath` probe. |
| aurora_get_credits | `tools/bridge/lib/kie.ts getRemainingCredits` + MVSEP `/api/app/user` (live-docs verified 2026-06-10) |
| aurora_get_workspace_state / list_projects / create_project / rename_project / delete_project | `src/main/storage/projects.ts` |
| aurora_list_assets / import_file / add_reference / delete_asset | `src/main/storage/assets.ts` (+`references.ts`) |
| aurora_get_stem_view / create_stem_set / delete_stem_set | `src/main/storage/stem-view.ts` + `stem-sets.ts`; split/extraction derived, stored sets reference files in place. Deletes require confirmation and remove rows only. |
| aurora_get_stem_peaks / measure_stems / export_stems | Local `stem-tools.ts` reads exact sets/lanes from `storage/stem-view.ts`; native-rate decoding, `audio/loudness.ts` BS.1770-4 mono/stereo + 4x true peak. Free/offline; peaks bounded to 2000 points/16 lanes. Exports write originals or aligned 44.1 kHz float32 ranges/mixes and manifests without overwriting. Mix gain is baked in; exclusive solos override mute; clipping is reported without limiting/normalisation. |
| aurora_import_split_job | `src/main/ingest/split-job.ts`; completed bridge jobs, canonical lanes only, legacy `ee` wins over intermediate `other`, repeated imports reuse the set. Free and local. |
| aurora_create/list/rename/delete_track / set_asset_track / favorite_asset | `src/main/storage/tracks.ts` + `assets.ts setAssetTrack/setAssetFavorite` (moves file/stems/extracts and reference paths) |
| aurora_fetch_wav | `suno-client.ts createWavConversion/pollWavConversion` + report §Phase 3 ("asset re-points at WAV, MP3 stays") |
| aurora_generate | `ipc/generation.ts generation:generate` landing + `kie.ts createGeneration` |
| aurora_sounds | `tools/bridge/commands/sounds.ts` + project landing per generation:generate |
| aurora_cover | `ipc/generation.ts runCover` (8-min cap, AIFF/FLAC standardize, custom-mode rule, model dots→underscores, best-effort WAV) |
| aurora_add_vocals / add_instrumental | Local `providers/suno.ts`, shared cover upload pipeline, generation landing via jobs; wire contract: `docs/suno-param-surface.md` |
| aurora_extend / replace_section / mashup | MCP-only Suno edits in `providers/suno.ts`: extend/replace_section use source provider ids when available, otherwise upload; mashup uploads both sources. Land source-linked `cover` assets via generation jobs (mashup linked to A); wire contract: `docs/suno-param-surface.md` |
| aurora_split | App `src/shared/separation/{routes,identify,content-check,mvsep-catalog.generated}.ts`, `src/main/split/run-route.ts`, separation contracts in `src/shared/types/index.ts` → GENERATED `separation/*.ts`. Local `split.ts`/`jobs.ts` track three routes, check before progressive landing and compute hats/Other locally. `estimateOnly` is free. |
| aurora_extract | Same generated checked routes + app `src/shared/extract-catalog.ts` → GENERATED `extract-catalog.ts`. Local `extract.ts`/`jobs.ts` advance the routeId plan sequentially, preserving attempts and partial outputs; `key-detect.ts`/`storage/extractions.ts` remain app ports. `estimateOnly` is free. |
| aurora_list_separation_routes | Local `separation-tools.ts`, backed by generated app routes/catalog; returns options, output keys, quality/evidence and checks without provider calls. |
| aurora_check_separation_result | Local `separation-tools.ts` + operation adapter replay generated `checkLocalOutputs`; job provenance distinguishes recorded checks from replay when auxiliary files are unavailable. Free, returns verdict/metrics/limitations. |
| aurora_cancel_job | Local `jobs.ts cancelJob`: durable cancellation intent; stops future units, retains saved files, no provider refund. |
| aurora_get_job_status / list_jobs | Local `jobs.ts` manifests + provider single-shot polls. Status supports `advance` and `waitSeconds` 0–30; advancement can spend. Snapshots never advance. Failed/partial results retain attempts, outputs and diagnostics with `isError:true`. |
| aurora_pitch_shift / convert | `tools/bridge/lib/ffmpeg-ops.ts` + `commands/{pitch,convert}.ts` |
| aurora_rvc_upscale / rip_midi | `src/main/rvc/upscale.ts` / `src/main/midi/rip.ts` (same args; resolution via AURORA_REPO) |
| aurora_get_prompting_guide | slates-mcp `resolveGuideTopic` pattern |

Known intentional deviations: (1) background cover lands MP3s only — WAV via fetch_wav (blocking cover keeps inline WAVs like the app); (2) generate/sounds land MP3 + audioId (the app's behavior) — bridge's default-WAV behavior is NOT carried (cost discipline).

**Scope:** Stack was removed from both projects. Generic navigation, working-asset selection and Library folder/checkbox selection use the live bridge. Offline stem measurements and exports use the local tools above; live stem-lane controls and mastering remain follow-ups. Historical Stack reference: second-brain `business/projects/aurora-docs/stack-feature-historical-reference.md`.

## Build / test

```bash
npm install
npm run build            # shared → mcp → cli
npm run typecheck        # mirror --check → build shared → check MCP/CLI
npm run smoke            # isolated stdio protocol checks, free
npm run test:contract    # isolated MCP audio contracts, free
npm run test:surface     # offline operation surface checks, free
npm run test:agent-bridge # fake loopback desktop + actual command queue, no Electron
npm run test:stem-sets   # isolated storage/read/import fixtures, free
npm run test:stem-tools  # synthetic waveform/loudness/export fixtures, offline
node packages/cli/dist/index.js status
```

**Invocation is `aurora run <op> --key value`**; there is no `aurora op`. `--help` on a `run` line prints generic help, never the op's schema: read its zod `input` block in `packages/shared/src/operations/index.ts`. Booleans pass as `--instrumental true`; `negativeTags` is ONE comma-separated string.

For manual write-heavy tests set `AURORA_USER_DATA=%TEMP%\aurora-mcp-test`, never real userData. Typecheck requires the app checkout beside this repo or `AURORA_REPO` pointing to it.

## Publishing

**Version 0.5.0.** To release: bump all three package versions and the exact shared pins in MCP/CLI, `npm install` (lockfile), then `npm run publish:all` at the root (shared, mcp-server, cli in that order). Token: `~/.npmrc`; scope/account details: second-brain `business/operations/account-logins.md`. Packages use `@ericdisero/*`; repository: public `github.com/EricDisero/aurora-mcp`. Smithery config exists but has not been submitted.

## Skills

`packages/shared/skills/*.md` is the single source, embedded at build. Derive names/count from those files or `aurora_get_prompting_guide`; do not keep another list. Frontmatter `name:` + `description:` required. `aurora install-skills` writes `.claude/skills/<name>/SKILL.md`. Track-S genre-craft skills come post-UEBS.
