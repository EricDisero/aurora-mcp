# @ericdisero/aurora-shared

The shared operations layer for Aurora's MCP server and CLI: SQLite/project-folder storage, Suno/MVSEP clients, durable jobs, checked split/extract orchestration and local audio operations. Both surfaces consume [`ALL_OPERATIONS`](src/operations/index.ts); its schemas, descriptions, annotations and output contracts define the tool surface.

Most users want `@ericdisero/aurora-mcp-server` or `@ericdisero/aurora-cli`.

[`separation/*.ts`](src/separation) and [`extract-catalog.ts`](src/extract-catalog.ts) are generated mirrors of the Aurora app, maintained by [`scripts/sync-separation.mjs`](../../scripts/sync-separation.mjs). Never edit them: change the app and resync. `--check` runs in root `npm run typecheck`, which also builds shared declarations before checking MCP/CLI. Set `AURORA_REPO` if the app checkout is not adjacent.

Split/extract queue durable jobs by default. Use `startSplitJob` and `advanceJob` for split integration; untracked submission is refused before spending. Every provider separation result passes exact-key identity and route-specific audio checks before landing. Route discovery and local checking are free; advancing jobs can submit paid provider work. Bundled guides come from `skills/*.md` and are embedded at build.

See the [repository README](../../README.md) for setup, job/cancellation semantics, check limitations, costs and free tests. Agents driving the app's live Mix/Export remain out of scope.

MIT. Copyright Blueprint Online Learning Inc.
