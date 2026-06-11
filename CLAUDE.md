# aurora-mcp — Claude code notes

MCP server + CLI + skills monorepo for Aurora (the AI audio workbench at `C:\Coding Projects\aurora\aurora`). Unlike slates-mcp (a thin HTTP transport), this package IS the worker: it operates directly on Aurora's userData DB + project folders and calls the cloud providers itself. The aurora app and this package share state through disk + SQLite (WAL), not through a server.

## Layout

```
aurora-mcp/
├── package.json                ← npm workspaces root (build / typecheck / publish:all)
├── smithery.yaml               ← Smithery registry config (stdio via npx) — NOT submitted yet
├── scripts/smoke-mcp.mjs       ← stdio protocol smoke test (initialize → tools/list → call)
└── packages/
    ├── shared/                 ← @ericdisero/aurora-shared
    │   skills/*.md             ← bundled agent recipes (single source)
    │   scripts/embed-skills.mjs← prebuild: skills/*.md → src/skills/content.ts (generated)
    │   src/
    │     paths.ts              ← userData/settings/projects-root resolution sans Electron
    │     config.ts             ← provider keys: env > ~/.aurora/config.json
    │     db.ts                 ← better-sqlite3 + the v1 migration (lockstep w/ app)
    │     storage/{projects,assets,stems,references}.ts  ← ports of aurora src/main/storage
    │     providers/{suno,mvsep}.ts ← provider clients (+ single-shot poll fetchers)
    │     split.ts              ← 3-job orchestration, PER-STEM PROGRESSIVE landing
    │     jobs.ts               ← background-job manifests (userData/agent-jobs/)
    │     stack.ts              ← stack.json CRUD + aligned multi-WAV export math
    │     sidecars.ts           ← RVC/MIDI python spawns (need AURORA_REPO env)
    │     audio/{ffmpeg,wav}.ts ← @ffmpeg-installer ops + RIFF codec (port)
    │     operations/index.ts   ← single source of truth for the 27-tool surface
    ├── mcp/                    ← @ericdisero/aurora-mcp-server (bin: aurora-mcp-server)
    └── cli/                    ← @ericdisero/aurora-cli (bin: aurora)
        src/commands/{op,install-skills,keys,status,mcp}.ts
```

## Hard rules

- **Never duplicate operation logic.** Both surfaces register the same `ALL_OPERATIONS` array. New tool = one edit in `packages/shared/src/operations/index.ts`.
- **Op schemas expose the FULL wire surface with sane defaults — curation is the app's job, never the MCP's** (locked 2026-06-10; the agent layer ships with MORE control than the app, never less). Param contract for the Suno ops: `docs/suno-param-surface.md`.
- **Schema lockstep with the aurora app.** `db.ts` mirrors `aurora/src/main/database/migrations.ts` at v2 (v2 = `extraction_stems`) and REFUSES to open a newer-versioned DB. If the app gains a v3 migration, port it here in the same session and bump `KNOWN_SCHEMA_VERSION`.
- **Storage-semantics lockstep.** `storage/*.ts`, `split.ts`, and `stack.ts` are ports of the app's modules (see the contract table below) — behavior changes go into BOTH codebases or neither.
- **Provider URLs expire server-side.** Always download-and-persist; `streamUrls` are preview-only, never stored as asset paths.
- **Destructive ops require `confirm: true`** (delete_asset, delete_project). Splits refuse to re-spend when 7 stems exist.
- **NEVER commit.** Eric commits at his checkpoints.

## Op ↔ source-module contract table

Every op's logic traces to a verified aurora module. Drift check = diff these pairs.

| Op | Source of truth (aurora repo) |
|---|---|
| aurora_get_credits | `tools/bridge/lib/kie.ts getRemainingCredits` + MVSEP `/api/app/user` (live-docs verified 2026-06-10) |
| aurora_get_workspace_state / list_projects / create_project / rename_project / delete_project | `src/main/storage/projects.ts` |
| aurora_list_assets / import_file / add_reference / delete_asset | `src/main/storage/assets.ts` (+`references.ts`) |
| aurora_fetch_wav | `suno-client.ts createWavConversion/pollWavConversion` + report §Phase 3 ("asset re-points at WAV, MP3 stays") |
| aurora_generate | `ipc/generation.ts generation:generate` landing + `kie.ts createGeneration` |
| aurora_sounds | `tools/bridge/commands/sounds.ts` + project landing per generation:generate |
| aurora_cover | `ipc/generation.ts runCover` (8-min cap, AIFF/FLAC standardize, custom-mode rule, model dots→underscores, best-effort WAV) |
| aurora_add_vocals / add_instrumental | NEW 2026-06-10 — same thin provider client (`providers/suno.ts`), upload pipeline shared with cover, lands as generation assets via the job system; param shapes verified in `docs/suno-param-surface.md` |
| aurora_split | `src/main/split/orchestrate.ts` (specs/pickFile/phase-cancel verbatim) restructured progressive |
| aurora_extract | `src/main/extract/orchestrate.ts` + `src/shared/extract-catalog.ts` (LOCKSTEP copies here: `extract.ts`, `extract-catalog.ts`, `key-detect.ts`, `storage/extractions.ts`), restructured as a sequential one-interaction-per-advance job; `estimateOnly` returns the call plan free |
| aurora_get_job_status / list_jobs | new (bridge `lib/job.ts` manifest discipline + provider single-shot polls) |
| aurora_pitch_shift / convert | `tools/bridge/lib/ffmpeg-ops.ts` + `commands/{pitch,convert}.ts` |
| aurora_rvc_upscale / rip_midi | `src/main/rvc/upscale.ts` / `src/main/midi/rip.ts` (same args; resolution via AURORA_REPO) |
| aurora_stack_* | `ipc/stack.ts` (stack.json shape) + `renderer stackStore.exportBundle` (padding math, Node port) |
| aurora_get_prompting_guide | slates-mcp `resolveGuideTopic` pattern |

Known intentional deviations: (1) background cover lands MP3s only — WAV via fetch_wav (blocking cover keeps inline WAVs like the app); (2) stack export standardizes non-44.1k sources via ffmpeg where the renderer's AudioContext resampled implicitly; (3) generate/sounds land MP3 + audioId (the app's behavior) — bridge's default-WAV behavior is NOT carried (cost discipline).

## Build / test

```bash
npm install
npm run build            # shared → mcp → cli
npm run typecheck
node scripts/smoke-mcp.mjs            # stdio protocol smoke (free)
node packages/cli/dist/index.js status
```

Test against an isolated library: set `AURORA_USER_DATA=%TEMP%\aurora-mcp-test` (never the real userData for write-heavy tests).

## Publishing

**0.2.0 is the current release (30 ops: +add_vocals, +add_instrumental, +extract; ultra-custom generate/cover schemas; schema v2). 0.1.0 was the first publish (2026-06-10 AM).** Next release: bump `version` in all THREE package.jsons AND the exact-version `@ericdisero/aurora-shared` dependency pins in packages/mcp + packages/cli (they must match shared's new version), then `npm run publish:all` from the root (shared lands before mcp/cli). Token in `~/.npmrc` (see second-brain `business/operations/account-logins.md` — needs read-write + ALL-packages scope; a package-scoped granular token 404s on new packages). Scope note: published under `@ericdisero/*` because the `auroradaw` npm org doesn't exist (free-tier org creation is web-UI-only — Eric's call whether to create it and republish under `@auroradaw/*`). github.com/EricDisero/aurora-mcp is PUBLIC (created + published 2026-06-10) — the npm listing's repo link resolves and Smithery submission is unblocked.

## Skills

`packages/shared/skills/*.md`, embedded at build. 4 bundled: music-production (workflow), cost-discipline, suno-prompting, split-and-stems. Frontmatter `name:`+`description:` required. `aurora install-skills` writes `.claude/skills/<name>/SKILL.md` (the correct discoverable layout). Track-S genre-craft skills come post-UEBS — only the delivery mechanism ships here.
