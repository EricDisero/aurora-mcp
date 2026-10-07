// Operations layer — the ONE place every Aurora agent tool is defined. Both the
// MCP server and the CLI register these as their tool / command surface
// (slates-mcp's single-registry rule, carried over). Every operation:
//   - has a stable string id (= the MCP tool name)
//   - has a Zod input schema (MCP tool definition AND CLI argument parsing)
//   - works directly against Aurora's userData DB + project folders (standalone
//     v1 — no running app required; renderer-bound mastering ops are deferred
//     to the app-integration follow-up)

import { join, extname, basename, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { AuroraDesktopClient, DesktopError, viewCommandSchema, viewReadSchema, viewAckSchema } from '../clients/desktop.js'
import { getDb } from '../db.js'
import { localRecipe, recipeText, recipeRefusal, reusableAncestor, reusePlan, creditsFor, type Recipe } from '../recipe.js'
import { v4 as uuidv4 } from 'uuid'
import { getDbPath, getProjectsDirectory, getUserDataDir } from '../paths.js'
import { getMvsepKey, getSunoKey, getKieKey } from '../config.js'
import {
  createAddInstrumental,
  createAddVocals,
  createCover,
  createExtend,
  createGeneration,
  createMashup,
  createReplaceSection,
  createSoundsGeneration,
  createUploadExtend,
  createWavConversion,
  DEFAULT_SUNO_MODEL,
  DURATION_MODELS,
  downloadTo,
  getRemainingCredits,
  host,
  normalizeModel,
  pollWavConversion,
  SUNO_MODELS,
  uploadAudioFile
} from '../providers/suno.js'
import { getMvsepUserInfo, separationError } from '../providers/mvsep.js'
import {
  createProject,
  deleteProject,
  getProject,
  getProjectDirectory,
  listProjects,
  renameProject
} from '../storage/projects.js'
import {
  addFileAsset,
  deleteAsset,
  getAsset,
  insertAsset,
  listAssets,
  setAssetFavorite,
  setAssetRefId,
  setAssetTrack,
  updateAssetPath
} from '../storage/assets.js'
import { addReference } from '../storage/references.js'
import {
  createTrack,
  deleteTrack,
  getTrack,
  getTrackDirectory,
  listTracks,
  renameTrack
} from '../storage/tracks.js'
import { getProjectStems, getStems } from '../storage/stems.js'
import { getExtractionStems } from '../storage/extractions.js'
import { getStemView } from '../storage/stem-view.js'
import { getStemPeaks, measureStems, exportStems } from '../stem-tools.js'
import { createStemSet, deleteStemSet, listStoredSets } from '../storage/stem-sets.js'
import { importSplitJob } from '../ingest/split-job.js'
import { advanceJob, cancelJob, isJobActive, listJobs, loadJob, newJobManifest, saveJob, startSplitJob, type JobManifest } from '../jobs.js'
import { prepareExtract } from '../extract.js'
import {
  EXTRACT_BUNDLES,
  EXTRACT_STEM_LABELS,
  EXTRACT_INDIVIDUAL_STEMS,
  VOCAL_STEM_IDS,
  estimateExtractCost,
  planApiCalls
} from '../extract-catalog.js'
import { checkSeparationOutputs, listSeparationRoutes, planSeparationRoute } from '../separation-tools.js'
import { SPLIT_ROUTES } from '../separation/routes.js'
import { probeDurationSeconds, standardizeToWav, convertToMp3, pitchShift } from '../audio/ffmpeg.js'
import { runRipMidi, runRvcUpscale } from '../sidecars.js'
import { SKILLS } from '../skills/content.js'
import { STEM_LABELS, normalizeStemId, type StemType, type JobError, type ProjectAsset, type SeparationAttempt } from '../types.js'

export interface OperationProgress {
  progress: number
  total?: number
  message: string
}

export interface OperationContext {
  desktop?: () => AuroraDesktopClient
  signal?: AbortSignal
  onProgress?: (progress: OperationProgress) => void | Promise<void>
}

export interface OperationAnnotations {
  title: string
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export interface OperationResult {
  text: string
  data: Record<string, unknown>
  structuredContent: Record<string, unknown>
  isError?: boolean
}

export interface Operation<I> {
  id: string
  description: string
  input: z.ZodType<I>
  outputSchema: z.ZodType
  annotations: OperationAnnotations
  run: (input: I, context?: OperationContext) => Promise<OperationResult>
}

function ok(data: Record<string, unknown>, text?: string): OperationResult {
  return { text: text ?? `Returned ${Object.keys(data).join(', ')}.`, data, structuredContent: data }
}

const errorSchema = z.object({
  code: z.string(), message: z.string(), retryable: z.boolean(), nextAction: z.string(),
  jobId: z.string().optional(), stage: z.string().optional(), httpStatus: z.number().optional()
})
const objectData = z.object({}).passthrough()
const projectSchema = z.object({ id: z.string(), name: z.string(), dirName: z.string(),
  createdAt: z.number(), updatedAt: z.number() }).passthrough()
const trackSchema = projectSchema.extend({ projectId: z.string(), sortOrder: z.number() })
const assetSchema = z.object({ id: z.string(), projectId: z.string(), trackId: z.string().nullable().optional(),
  kind: z.enum(['generation', 'cover', 'track', 'master']), name: z.string(), path: z.string(),
  origin: z.record(z.unknown()).nullable().optional(), sourceAssetId: z.string().nullable().optional(),
  refId: z.string().nullable().optional(), favorite: z.boolean(), createdAt: z.number(),
  recipe: z.record(z.unknown()) }).passthrough()
const stemSchema = z.object({ stemType: z.string(), path: z.string(), recipe: z.record(z.unknown()).optional() }).passthrough()
const stemLaneSchema = z.object({ stemKey: z.string(), label: z.string(), path: z.string() })
const storedSetSchema = z.object({
  id: z.string(), projectId: z.string(), assetId: z.string(), kind: z.enum(['import', 'custom']),
  name: z.string(), sourcePath: z.string().nullable(), createdAt: z.number(), recipe: z.record(z.unknown()),
  lanes: z.array(stemLaneSchema.extend({ id: z.string(), setId: z.string(), sortOrder: z.number() }))
})
const stemViewSchema = z.object({
  asset: z.object({ id: z.string(), projectId: z.string(), trackId: z.string().nullable(), name: z.string(), path: z.string() }),
  sets: z.array(z.object({ key: z.string(), kind: z.enum(['split', 'extraction', 'import', 'custom']), name: z.string(),
    lanes: z.array(stemLaneSchema.extend({ laneId: z.string(), available: z.boolean(),
      group: z.literal('drums').nullable(), sortOrder: z.number(), recipe: z.record(z.unknown()).optional() })) }))
})
const attemptSchema = z.object({
  routeId: z.string(), status: z.enum(['pending', 'submitting', 'accepted', 'landed', 'failed', 'uncertain']),
  hash: z.string().optional(), deliveredStemIds: z.array(z.string()), error: errorSchema.optional(),
  checks: objectData.optional()
}).passthrough()
const jobSchema = z.object({
  jobId: z.string(), kind: z.string(), status: z.enum(['queued', 'submitting', 'waiting', 'landing',
    'completed', 'partial', 'failed', 'cancelled', 'running', 'done', 'error']),
  stage: z.string(), projectId: z.string(), assetIds: z.array(z.string()), stems: z.array(stemSchema),
  lastError: errorSchema.optional(), splitAttempts: z.record(attemptSchema).optional(),
  callResults: z.array(attemptSchema).optional(), requestedStemIds: z.array(z.string()).optional(),
  extractedFiles: z.record(z.string()).optional(), detectedKey: z.string().nullable().optional(),
  sourceAssetId: z.string().optional(),
  provider: z.object({ taskId: z.string().optional(), assetId: z.string().optional(),
    hashes: z.record(z.string()).optional(),
    extract: z.object({ calls: z.array(objectData), callIndex: z.number() }).optional()
  }).optional(),
  createdAt: z.string(), updatedAt: z.string()
}).passthrough()
const checkSchema = z.object({
  ok: z.boolean(), problems: z.array(z.string()), notes: z.array(z.string()),
  metrics: z.record(z.number()), checkWindowSeconds: z.number(), limitations: z.array(z.string())
}).passthrough()
const routeSchema = z.object({
  id: z.string(), label: z.string(), algorithm: z.string().nullable(), sep_type: z.string(),
  options: z.record(z.string()), delivers: z.record(z.string()), outputKeys: z.array(z.string()),
  checks: z.object({ family: objectData, sums: z.array(objectData) }),
  quality: z.enum(['good', 'fair', 'rough', 'untested']), evidence: z.string(),
  surface: z.enum(['split', 'extract group', 'extract instrument', 'extract bundle'])
}).passthrough()
const planSchema = z.object({
  calls: z.array(objectData), totalCalls: z.number(), durationSeconds: z.number().nullable(),
  durationConfidence: z.enum(['probed', 'unknown']), providerUnits: objectData, price: z.null()
}).passthrough()

const EXTRACT_SELECTION_IDS = [...new Set([
  ...Object.keys(EXTRACT_INDIVIDUAL_STEMS),
  ...Object.values(EXTRACT_BUNDLES).flatMap((bundle) => bundle.stems)
])].filter((id) => !VOCAL_STEM_IDS.has(id))

const stemIdSchema = z.string().transform(normalizeStemId)

function separationPlan(routeIds: string[], durationSeconds: number | null, topology?: unknown[]): Record<string, unknown> {
  const routes = listSeparationRoutes()
  return {
    totalCalls: routeIds.length, durationSeconds, durationConfidence: durationSeconds === null ? 'unknown' : 'probed',
    calls: routeIds.map((id, index) => {
      const planned = planSeparationRoute(id)
      const call = topology?.[index] as { addOpt1?: number; addOpt2?: number } | undefined
      const route = routes.find((route) => route.id === id)!
      return { ...planned, topology: topology?.[index], options: { ...planned.options,
        ...(call?.addOpt1 === undefined ? {} : { add_opt1: String(call.addOpt1) }),
        ...(call?.addOpt2 === undefined ? {} : { add_opt2: String(call.addOpt2) }) },
        quality: route.quality, evidence: route.evidence, checks: { family: route.family, sums: route.sums } }
    }),
    providerUnits: { roundedInputMinutes: durationSeconds === null ? null : Math.ceil(durationSeconds / 60),
      processedCallMinutes: durationSeconds === null ? null : routeIds.length * Math.ceil(durationSeconds / 60),
      premiumMinutes: null, rate: null, rateVerifiedAt: null,
      provenance: 'Local duration probe and catalog call topology; current provider billing rate is unverified.',
      rounding: 'Each call uses input seconds rounded up to whole minutes; chained input duration may differ.' },
    price: null, note: 'No upload or paid call. Catalog credits are future Aurora metering, not a current provider price.'
  }
}

// Root objects are required by MCP. The engine's additive provenance fields are preserved.
function outputSchema(success: z.ZodType): z.ZodType {
  return z.union([success, z.object({ error: errorSchema }).passthrough()])
}

const getViewOp: Operation<Record<string, never>> = {
  id: 'aurora_get_view',
  description: 'Read what the running Aurora desktop window reports: route, open working asset, Library checkbox selection, active panel, project, track folder, revision and observation time. No provider calls. A stopped app returns desktop app not connected and state:null; a window that has not reported also returns state:null. Read before changing the view and use its revision as expectedRevision.',
  input: z.object({}).strict(),
  outputSchema: outputSchema(viewReadSchema),
  annotations: { title: 'Read desktop view', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(_input, context) {
    const data = await (context?.desktop?.() ?? new AuroraDesktopClient()).getView()
    return { ...ok(data, data.state ? `Aurora shows ${data.state.activePanel} on ${data.state.route}, revision ${data.state.revision}.` : data.reason ?? 'No renderer view has been reported.'),
      ...(!data.connected ? { isError: true } : {}) }
  }
}

const setViewOp: Operation<z.infer<typeof viewCommandSchema>> = {
  id: 'aurora_set_view',
  description: 'Change the running Aurora view when the user asks to show or open something. patch.page: create/library (same home), extract, finish/split, or settings (modal over the current route). openAssetId selects the working asset in the open project; from home it opens Split, otherwise it keeps the route; null clears it. selectedAssetIds replaces Library checkboxes; Library must be showing and ids must belong to the open project; selections persist across Library filters. libraryTrackId focuses Library on a track folder in the open project; null shows All, "unfiled" shows unfiled. composer loads fromAssetId, mode, fields and notes on a desktop advertising composer-load; use reuse_prompt/reuse_reference to derive them. Use list_assets/list_tracks for ids. Supply a unique requestId and optionally expectedRevision from get_view. Duplicate ids return the first result for this app process, even after a timeout. Only applied confirms every requested field; partial/rejected give reasons. uncertain means no confirmed outcome: read get_view or retrieve the first result with the SAME requestId before doing more. No generation, separation, playback or mastering is performed.',
  input: viewCommandSchema,
  outputSchema: outputSchema(viewAckSchema),
  annotations: { title: 'Change desktop view', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(input, context) {
    const data = await (context?.desktop?.() ?? new AuroraDesktopClient()).setView(input)
    return { ...ok(data, `${data.status}: ${data.reasons.join('; ') || `view revision ${data.revision}`}`),
      ...(data.status !== 'applied' ? { isError: true } : {}) }
  }
}

/** One error contract for CLI and MCP; provider details are preserved when available. */
export function operationFailure(error: unknown, jobId?: string): OperationResult {
  const message = separationError(error).message
  let detail: JobError
  if (error instanceof z.ZodError) {
    detail = { code: 'INVALID_ARGUMENT', message: error.issues.map((issue) =>
      `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '), retryable: false,
      nextAction: 'Correct the named arguments using this tool\'s inputSchema and retry.' }
  } else if (error && typeof error === 'object' && 'code' in error && 'nextAction' in error) {
    const known = error as JobError
    const code = ({ JOB_NOT_FOUND: 'NOT_FOUND', JOB_ID_INVALID: 'INVALID_ARGUMENT', SEPARATION_ROUTE_UNKNOWN: 'INVALID_ARGUMENT' } as Record<string, string>)[known.code] ?? known.code
    detail = { code, message: separationError(new Error(known.message)).message, retryable: known.retryable,
      nextAction: known.nextAction, stage: known.stage, httpStatus: known.httpStatus }
  } else if (error instanceof Error && error.name === 'OutputIdentityError') {
    detail = separationError(error)
  } else {
    const code = /not found|does not exist|no .* stem|no guide matching|missing on disk|ENOENT/i.test(message) ? 'NOT_FOUND' :
      /(?:API_KEY|key).*?(?:missing|configured|required)|missing.*key/i.test(message) ? 'MISSING_KEY' :
      /confirm/i.test(message) ? 'CONFIRMATION_REQUIRED' :
      /provide|requires|unknown|nothing selected|caps at|duration|must|needs both|pass .*with/i.test(message) ? 'INVALID_ARGUMENT' : 'OPERATION_FAILED'
    detail = { code, message, retryable: false, nextAction: code === 'NOT_FOUND' ?
      'List the relevant projects, assets or jobs; verify local paths before retrying.' : code === 'MISSING_KEY' ?
      'Configure the provider key with aurora keys set or the MCP environment, then retry.' :
      code === 'CONFIRMATION_REQUIRED' ? 'Review the deletion and supply confirm:true only when authorized.' :
      'Review the message and input schema. Check job status before repeating any paid call.' }
  }
  const data = { error: { ...detail, ...(jobId ? { jobId } : {}) } }
  return { ...ok(data, `${detail.code}: ${detail.message} ${detail.nextAction}`), isError: true }
}

// Suno model surface (docs.sunoapi.org, re-verified 2026-09-14 after the v6
// launch): V6 | V6_WILD | V6_MINI are current on EVERY endpoint, sounds
// included; V5_5 and older are deprecated (still accepted on sunoapi.org,
// "Discontinued" on kie.ai). Enum + default live in providers/suno.ts.
const DEFAULT_GEN_MODEL = DEFAULT_SUNO_MODEL
const MODEL_DESCRIBE =
  `${SUNO_MODELS.slice(0, 3).join(' | ')} (default ${DEFAULT_GEN_MODEL}; V6_WILD = more varied/experimental, ` +
  'V6_MINI = fast/cheap draft). Deprecated but still accepted: V5_5 | V5 | V4_5PLUS | V4_5ALL | V4_5 | V4. Dots normalized'
const varietySchema = z
  .number()
  .int()
  .min(0)
  .max(4)
  .optional()
  .describe(
    'Suno Variety: 0 Off, 1 Normal, 2 High, 3 Extra, 4 Max (provider default 1). Above 0 Suno rewrites the style per take; 0 keeps the style exactly as written'
  )
const durationSchema = z
  .number()
  .int()
  .min(10)
  .max(360)
  .optional()
  .describe(
    'Target length in seconds (10-360). Honoured ONLY in custom mode on V5_5 / V6 / V6_WILD / V6_MINI — silently ignored elsewhere'
  )

/** Loud error instead of a silently-ignored duration (the param has model + mode gates). */
function assertDurationUsable(duration: number | undefined, model: string, customMode: boolean): void {
  if (duration === undefined) return
  if (!customMode) throw new Error('duration requires customMode true (style + title set).')
  if (!DURATION_MODELS.has(model)) {
    throw new Error(`duration is honoured only on ${[...DURATION_MODELS].join(', ')} — you picked ${model}.`)
  }
}
const MAX_COVER_REFERENCE_SECONDS = 8 * 60

const BACKGROUND_DESCRIBE =
  'Submit and return immediately with a jobId instead of blocking. Poll aurora_get_job_status ' +
  'every 10-20s. Status includes streamUrls you can hand the user to LISTEN mid-generation, ' +
  'before files land. Jobs survive process restarts (provider-side state).'

const landingTrackIdSchema = z
  .string()
  .optional()
  .describe(
    'Land the output in this track (project subfolder — aurora_list_tracks shows ids). Omit = project root'
  )

/** Validate a landing trackId: must exist and belong to the target project.
 *  Loud error (not silent root-landing) — agents should know they missed. */
function resolveLandingTrack(projectId: string, trackId?: string): string | null {
  if (!trackId) return null
  const track = getTrack(trackId)
  if (!track || track.projectId !== projectId) {
    throw new Error(
      `Track ${trackId} does not exist in project ${projectId} — call aurora_list_tracks for valid ids.`
    )
  }
  return trackId
}

function assertNotAborted(context?: OperationContext): void {
  if (context?.signal?.aborted) throw Object.assign(new Error('Request cancelled; accepted provider work may still run.'), {
    code: 'REQUEST_CANCELLED', retryable: false,
    nextAction: 'Inspect existing jobs. Use aurora_cancel_job to durably stop further units; credits are not refunded.'
  })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const finish = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/** Blocking wrapper: advance the job every 5s up to ~12 min, then degrade
 *  gracefully to "still running" instead of erroring (MCP clients can time out
 *  long tool calls — the job itself is provider-side and loses nothing). */
async function awaitJob(m: JobManifest, context?: OperationContext, waitMs = 12 * 60 * 1000): Promise<JobManifest> {
  const start = Date.now()
  let current = m
  let completedUnits = 0
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (context?.signal?.aborted) abort()
  context?.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, waitMs)
  try {
    while (isJobActive(current) && !controller.signal.aborted && Date.now() - start < waitMs) {
      current = await advanceJob(current, controller.signal)
      completedUnits = Math.max(completedUnits, Object.values(current.landed).filter(Boolean).length,
        current.provider.extract?.callIndex ?? 0)
      await context?.onProgress?.({ progress: completedUnits, message: `${current.jobId}: ${current.status} — ${current.stage}` })
      if (isJobActive(current)) await sleep(Math.min(current.pollIntervalMs ?? 5000, Math.max(0, waitMs - (Date.now() - start))), controller.signal)
    }
    return current
  } finally { clearTimeout(timer); context?.signal?.removeEventListener('abort', abort) }
}

function jobSummary(m: JobManifest): Record<string, unknown> {
  return {
    jobId: m.jobId,
    kind: m.kind,
    status: m.status,
    stage: m.stage,
    lastError: m.lastError ?? (m.error ? { code: 'JOB_FAILED', message: m.error, retryable: false,
      nextAction: 'Inspect the job and existing outputs before starting replacement paid work.' } : undefined),
    projectId: m.projectId,
    assetIds: m.assetIds,
    stems: m.stems,
    splitAttempts: m.provider.splitAttempts,
    callResults: m.provider.extract?.callResults,
    requestedStemIds: m.provider.extract?.requestedStemIds,
    extractedFiles: m.provider.extract?.extractedFiles,
    detectedKey: m.provider.extract?.detectedKey,
    sourceAssetId: m.provider.assetId,
    // Provider ids and the extraction plan only: the attempts and results are reported once, above.
    provider: {
      taskId: m.provider.taskId, assetId: m.provider.assetId, hashes: m.provider.hashes,
      extract: m.provider.extract ? { calls: m.provider.extract.calls, callIndex: m.provider.extract.callIndex } : undefined
    },
    failures: m.provider.extract?.failures,
    cancelRequestedAt: m.cancelRequestedAt,
    duplicateOf: m.duplicateOf,
    streamUrls: m.streamUrls && m.streamUrls.length > 0 ? m.streamUrls : undefined,
    lastProviderStatus: m.lastStatus,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt
  }
}

function jobText(m: JobManifest): string {
  if (m.status === 'done' || m.status === 'completed') {
    const assets = m.assetIds.length > 0 ? ` ${m.assetIds.length} asset(s): ${m.assetIds.join(', ')}.` : ''
    const stems = m.stems.length > 0 ? ` ${m.stems.length} stem(s) landed.` : ''
    return `Job ${m.jobId} complete.${assets}${stems} Files are on disk in the project folder.`
  }
  if (m.status === 'error' || m.status === 'failed') return `Job ${m.jobId} FAILED: ${m.lastError?.message ?? m.error}`
  if (m.status === 'partial') return `Job ${m.jobId} partially completed: successful outputs are retained. ${m.lastError?.message ?? m.error ?? ''} Inspect callResults and check saved outputs before authorizing new paid work.`
  if (m.status === 'cancelled') return `Job ${m.jobId} cancelled. Saved outputs stay; already submitted provider work may still run and is not refunded.`
  const stream =
    m.streamUrls && m.streamUrls.length > 0
      ? ` Stream preview available NOW (play these URLs for the user before files land): ${m.streamUrls.join(' , ')}`
      : ''
  return `Job ${m.jobId} ${m.status} — ${m.stage}.${stream} Advance with aurora_get_job_status; it may submit paid calls and land files.`
}

async function resolveProjectOrCreate(projectId: string | undefined, fallbackName: string): Promise<string> {
  if (projectId) {
    const p = getProject(projectId)
    if (!p) throw new Error(`Project not found: ${projectId}. Use aurora_list_projects.`)
    return p.id
  }
  const created = await createProject(fallbackName)
  return created.id
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'track'
}

/** Resolve an op input that may be an assetId or a raw file path. */
function resolveAudioInput(input: { assetId?: string; path?: string }): {
  path: string
  asset: ProjectAsset | null
} {
  if (input.assetId) {
    const asset = getAsset(input.assetId)
    if (!asset) throw new Error(`Asset not found: ${input.assetId}. Use aurora_list_assets.`)
    if (!existsSync(asset.path)) throw new Error(`Asset audio file is missing on disk: ${asset.path}`)
    return { path: asset.path, asset }
  }
  if (input.path) {
    if (!existsSync(input.path)) throw new Error(`File not found: ${input.path}`)
    return { path: input.path, asset: null }
  }
  throw new Error('Provide either assetId or path.')
}

// ── Identity / workspace ────────────────────────────────────────

const getCredits: Operation<Record<string, never>> = {
  id: 'aurora_get_credits',
  annotations: { title: 'Cloud credit balances', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  outputSchema: outputSchema(z.object({ sunoCredits: z.number().optional(), sunoError: errorSchema.optional(), mvsepPremiumMinutes: z.number().nullable().optional(), mvsepError: errorSchema.optional() }).passthrough()),
  description: "Free cloud balance read: returns Suno credits and MVSEP premium minutes or per-provider diagnostics, with no generation spend. No inputs. Requires configured provider keys and network access. Read before authorizing paid work and again afterward to measure real spend.",
  input: z.object({}).strict(),
  async run(_input, context) {
    const result: Record<string, unknown> = {}
    try {
      result.sunoCredits = await getRemainingCredits()
      result.sunoProvider = host()
    } catch (err) {
      result.sunoError = operationFailure(err).structuredContent.error
    }
    assertNotAborted(context)
    if (getMvsepKey()) {
      try {
        const info = await getMvsepUserInfo()
        result.mvsepPremiumMinutes = info.premiumMinutes
        result.mvsepPremiumEnabled = info.premiumEnabled
      } catch (err) {
        result.mvsepError = operationFailure(err).structuredContent.error
      }
    } else {
      result.mvsepError = operationFailure(new Error('MVSEP_API_KEY not configured')).structuredContent.error
    }
    if (result.sunoError || result.mvsepError) {
      const failure = result.sunoError ?? result.mvsepError
      return { ...ok({ ...result, error: failure }, 'Some balances were unavailable; inspect provider diagnostics.'), isError: true }
    }
    return ok(result)
  }
}

const getWorkspaceState: Operation<{ projectId?: string }> = {
  id: 'aurora_get_workspace_state',
  annotations: { title: 'Workspace snapshot', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ userData: z.string(), database: z.string(), projectsRoot: z.string(), keys: objectData, projects: z.array(projectSchema), activeProject: objectData.optional() })),
  description: "Free local workspace snapshot: returns paths, key-presence flags and projects; optional projectId adds that project's tracks, assets and split stems. Does not upload audio or reveal keys. Call at session start, then list assets or routes before planning paid work.",
  input: z.object({ projectId: z.string().optional() }),
  async run(input, context) {
    const projects = listProjects()
    let activeProject: unknown
    if (input.projectId) {
      const p = getProject(input.projectId)
      if (!p) throw new Error(`Project not found: ${input.projectId}`)
      activeProject = {
        ...p,
        directory: getProjectDirectory(p.id),
        tracks: listTracks(p.id),
        assets: listAssets(p.id),
        stems: getProjectStems(p.id)
      }
    }
    return ok({
      userData: getUserDataDir(),
      database: getDbPath(),
      projectsRoot: getProjectsDirectory(),
      keys: {
        suno: Boolean(getSunoKey() || getKieKey()),
        mvsep: Boolean(getMvsepKey())
      },
      projects,
      activeProject
    })
  }
}

// ── Projects ────────────────────────────────────────────────────

const createProjectOp: Operation<{ name: string }> = {
  id: 'aurora_create_project',
  annotations: { title: 'Create project', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  outputSchema: outputSchema(z.object({ project: projectSchema, directory: z.string() })),
  description: "Free local write: create a project and folder from required name. Returns project id and directory. List tracks or import/generate assets into the returned project; repeating creates another project.",
  input: z.object({ name: z.string().min(1).describe('Project name, e.g. "Midnight Drive"') }),
  async run(input, context) {
    const project = await createProject(input.name)
    return ok({ project, directory: getProjectDirectory(project.id) })
  }
}

const listProjectsOp: Operation<Record<string, never>> = {
  id: 'aurora_list_projects',
  annotations: { title: 'List projects', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ projects: z.array(projectSchema), projectsRoot: z.string() })),
  description: "Free local read, no inputs: returns every project with ids, names and timestamps plus projectsRoot. Nothing uploads. Use a returned projectId with aurora_list_assets or aurora_list_tracks.",
  input: z.object({}).strict(),
  async run() {
    return ok({ projects: listProjects(), projectsRoot: getProjectsDirectory() })
  }
}

const renameProjectOp: Operation<{ projectId: string; name: string }> = {
  id: 'aurora_rename_project',
  annotations: { title: 'Rename project', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ project: projectSchema })),
  description: "Free local write: set the display name of projectId to name; folder name stays the same. Returns the updated project. Repeatable with the same name. Verify with aurora_list_projects.",
  input: z.object({ projectId: z.string(), name: z.string().min(1) }),
  async run(input, context) {
    return ok({ project: renameProject(input.projectId, input.name) })
  }
}

const deleteProjectOp: Operation<{ projectId: string; confirm?: boolean }> = {
  id: 'aurora_delete_project',
  annotations: { title: 'Delete project and files', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ deleted: z.string() })),
  description: "Free destructive local write: projectId and confirm:true remove its rows and entire audio folder. Without confirmation returns CONFIRMATION_REQUIRED. Returns deleted id. Review aurora_list_assets before authorizing this irreversible deletion.",
  input: z.object({
    projectId: z.string(),
    confirm: z.boolean().optional().describe('Must be true. Confirm with the user before calling.')
  }),
  async run(input, context) {
    const project = getProject(input.projectId)
    if (!project) throw new Error(`Project not found: ${input.projectId}`)
    if (!input.confirm) throw new Error(`Confirmation required: confirm:true deletes project "${project.name}" and its folder ${getProjectDirectory(project.id)}.`)
    await deleteProject(input.projectId)
    return ok({ deleted: project.id }, `Deleted project "${project.name}" and its folder.`)
  }
}

const listAssetsOp: Operation<{ projectId: string }> = {
  id: 'aurora_list_assets',
  annotations: { title: 'List assets and split stems', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ project: projectSchema, directory: z.string(), assets: z.array(assetSchema) })),
  description: "Free local read: required projectId returns project, directory and assets with stored provider ids, paths and seven-stem split rows. Nothing uploads. Reuse existing outputs; choose assetId for a free separation estimate before paid extraction or split.",
  input: z.object({ projectId: z.string() }),
  async run(input, context) {
    const project = getProject(input.projectId)
    if (!project) throw new Error(`Project not found: ${input.projectId}`)
    const assets = listAssets(input.projectId)
    const stems = getProjectStems(input.projectId)
    const stemsByAsset: Record<string, typeof stems> = {}
    for (const s of stems) {
      ;(stemsByAsset[s.assetId] ??= []).push(s)
    }
    return ok({
      project,
      directory: getProjectDirectory(project.id),
      assets: assets.map((a) => ({ ...a, stems: stemsByAsset[a.id] ?? [] }))
    })
  }
}

// ── Tracks (project subfolders — one per song in a multi-track release) ──

const createTrackOp: Operation<{ projectId: string; name: string }> = {
  id: 'aurora_create_track',
  annotations: { title: 'Create track folder', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  outputSchema: outputSchema(z.object({ track: trackSchema, directory: z.string() })),
  description: "Free local write: required projectId and name create a track subfolder for organizing songs. Returns track id and directory. Repeating creates another track. Use trackId for import/generation landing or aurora_set_asset_track.",
  input: z.object({
    projectId: z.string(),
    name: z.string().min(1).describe('Track name, e.g. "Main Theme"')
  }),
  async run(input, context) {
    const track = await createTrack(input.projectId, input.name)
    return ok({ track, directory: getTrackDirectory(track.id) })
  }
}

const listTracksOp: Operation<{ projectId: string }> = {
  id: 'aurora_list_tracks',
  annotations: { title: 'List track folders', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ project: objectData, tracks: z.array(trackSchema), unfiledCount: z.number() })),
  description: "Free local read: required projectId returns track ids, directories, per-track asset counts and unfiledCount. Nothing uploads. Use trackId for landing new assets or aurora_set_asset_track.",
  input: z.object({ projectId: z.string() }),
  async run(input, context) {
    const project = getProject(input.projectId)
    if (!project) throw new Error(`Project not found: ${input.projectId}`)
    const tracks = listTracks(input.projectId)
    const assets = listAssets(input.projectId)
    const countByTrack = new Map<string, number>()
    for (const a of assets) {
      const key = a.trackId ?? 'unfiled'
      countByTrack.set(key, (countByTrack.get(key) ?? 0) + 1)
    }
    return ok({
      project: { id: project.id, name: project.name },
      tracks: tracks.map((t) => ({
        ...t,
        directory: getTrackDirectory(t.id),
        assetCount: countByTrack.get(t.id) ?? 0
      })),
      unfiledCount: countByTrack.get('unfiled') ?? 0
    })
  }
}

const renameTrackOp: Operation<{ trackId: string; name: string }> = {
  id: 'aurora_rename_track',
  annotations: { title: 'Rename track', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ track: trackSchema })),
  description: "Free local write: required trackId and name change its display name, retaining the folder slug. Returns updated track. Repeatable with the same name. Verify with aurora_list_tracks.",
  input: z.object({ trackId: z.string(), name: z.string().min(1) }),
  async run(input, context) {
    if (!getTrack(input.trackId)) throw new Error(`Track not found: ${input.trackId}`)
    return ok({ track: renameTrack(input.trackId, input.name) })
  }
}

const deleteTrackOp: Operation<{ trackId: string }> = {
  id: 'aurora_delete_track',
  annotations: { title: 'Delete track folder and unfile assets', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ deleted: z.string() })),
  description: "Free local write: required trackId removes the track and moves its assets, stems and references to the project root; audio is retained. Returns deleted id. No provider calls. List tracks/assets afterward to inspect their new locations.",
  input: z.object({ trackId: z.string() }),
  async run(input, context) {
    const track = getTrack(input.trackId)
    if (!track) throw new Error(`Track not found: ${input.trackId}`)
    await deleteTrack(input.trackId)
    return ok(
      { deleted: track.id },
      `Deleted track "${track.name}". Its assets moved back to the project root.`
    )
  }
}

const setAssetTrackOp: Operation<{ assetId: string; trackId: string | null }> = {
  id: 'aurora_set_asset_track',
  annotations: { title: 'Move asset to track', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ asset: assetSchema })),
  description: "Free local write: required assetId and nullable trackId physically move audio, split/extracted stems and linked reference paths; null unfiles to the project root. Returns updated asset. Repeating the same target is safe. List tracks first and assets afterward.",
  input: z.object({
    assetId: z.string(),
    trackId: z
      .string()
      .nullable()
      .describe('Target track id, or null to move the asset back to the project root')
  }),
  async run(input, context) {
    const asset = await setAssetTrack(input.assetId, input.trackId)
    return ok({ asset })
  }
}

const favoriteAssetOp: Operation<{ assetId: string; favorite: boolean }> = {
  id: 'aurora_favorite_asset',
  annotations: { title: 'Set asset favorite', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ asset: assetSchema })),
  description: "Free local write: required assetId and favorite boolean set or clear the library favorite flag. Returns updated asset. Repeatable with the same flag; inspect aurora_list_assets afterward.",
  input: z.object({ assetId: z.string(), favorite: z.boolean() }),
  async run(input, context) {
    const asset = setAssetFavorite(input.assetId, input.favorite)
    return ok({ asset })
  }
}

// ── Asset management ────────────────────────────────────────────

const importFileOp: Operation<{ projectId: string; trackId?: string; filePath: string }> = {
  id: 'aurora_import_file',
  annotations: { title: 'Import local audio', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  outputSchema: outputSchema(z.object({ asset: assetSchema })),
  description: "Free local write: required projectId and absolute filePath copy audio into the library; optional trackId lands in that track, otherwise project root. Returns a new track asset id/path. Repeating duplicates the import. List assets, then estimate separation or explicitly authorize paid generation.",
  input: z.object({
    projectId: z.string(),
    trackId: z.string().optional().describe('File the track into this track subfolder'),
    filePath: z.string().describe('Absolute path to the audio file to import')
  }),
  async run(input, context) {
    if (!existsSync(input.filePath)) throw new Error(`File not found: ${input.filePath}`)
    const asset = await addFileAsset({
      projectId: input.projectId,
      trackId: input.trackId ?? null,
      filePath: input.filePath
    })
    return ok({ asset })
  }
}

const addReferenceOp: Operation<{ projectId: string; trackId?: string; filePath: string }> = {
  id: 'aurora_add_reference',
  annotations: { title: 'Import reusable reference', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  outputSchema: outputSchema(z.object({ asset: assetSchema })),
  description: "Free local write: projectId and absolute filePath import a new audio asset and register it as a reusable mastering reference; optional trackId selects a subfolder, otherwise root. Returns linked asset. No upload or credit spend. Use the app mastering flow or aurora_list_assets next.",
  input: z.object({
    projectId: z.string(),
    trackId: z.string().optional().describe('File the track into this track subfolder'),
    filePath: z.string().describe('Absolute path to the reference audio file')
  }),
  async run(input, context) {
    if (!existsSync(input.filePath)) throw new Error(`File not found: ${input.filePath}`)
    const asset = await addFileAsset({
      projectId: input.projectId,
      trackId: input.trackId ?? null,
      filePath: input.filePath
    })
    // Opt-in reusable-reference: stamp the curve-cache row on the new track.
    const ref = await addReference(asset.path, { copy: false })
    const linked = setAssetRefId(asset.id, ref.id)
    return ok({ asset: linked })
  }
}

const deleteAssetOp: Operation<{ assetId: string; confirm?: boolean }> = {
  id: 'aurora_delete_asset',
  annotations: { title: 'Delete asset and files', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ deleted: z.string() })),
  description: "Free destructive local write: assetId and confirm:true delete its row, audio, stems and linked reference. Without confirmation returns CONFIRMATION_REQUIRED. Returns deleted id. Inspect paths via aurora_list_assets before authorizing irreversible deletion.",
  input: z.object({
    assetId: z.string(),
    confirm: z.boolean().optional().describe('Must be true. Confirm with the user before calling.')
  }),
  async run(input, context) {
    const asset = getAsset(input.assetId)
    if (!asset) throw new Error(`Asset not found: ${input.assetId}`)
    if (!input.confirm) throw new Error(`Confirmation required: confirm:true deletes asset "${asset.name}", ${asset.path}, its stems and linked reference.`)
    await deleteAsset(input.assetId)
    return ok({ deleted: asset.id }, `Deleted asset "${asset.name}".`)
  }
}

const recipeSubjectInput = z.object({ assetId: z.string().min(1).optional(), stemId: z.string().min(1).optional() })
  .strict().refine((input) => (input.assetId === undefined) !== (input.stemId === undefined), 'Provide exactly one assetId or stemId')
type RecipeSubject = { subject: { type: 'asset' | 'stem' | 'extraction' | 'stemSet'; id: string; name: string }; recipe: Recipe }
const nameOfAsset = (id: string): string | null => getAsset(id)?.name ?? null
const recipeOfAsset = (id: string): Recipe | null => getAsset(id)?.recipe ?? null

function findRecipe(input: z.infer<typeof recipeSubjectInput>): RecipeSubject {
  if (input.assetId) {
    const asset = getAsset(input.assetId)
    if (!asset) throw new Error(`Asset not found: ${input.assetId}`)
    return { subject: { type: 'asset', id: asset.id, name: asset.name }, recipe: asset.recipe }
  }
  // Table names are fixed here; only the exact subject id is a query parameter.
  for (const table of ['project_stems', 'extraction_stems', 'stem_sets'] as const) {
    const row = getDb().prepare(`SELECT asset_id FROM ${table} WHERE id = ?`).get(input.stemId) as { asset_id: string } | undefined
    if (!row) continue
    if (table === 'project_stems') {
      const stem = getStems(row.asset_id).find((stem) => stem.id === input.stemId)!
      return { subject: { type: 'stem', id: stem.id, name: STEM_LABELS[stem.stemType] }, recipe: stem.recipe }
    }
    if (table === 'extraction_stems') {
      const stem = getExtractionStems(row.asset_id).find((stem) => stem.id === input.stemId)!
      return { subject: { type: 'extraction', id: stem.id, name: EXTRACT_STEM_LABELS[stem.stemId] ?? stem.stemId }, recipe: stem.recipe }
    }
    const set = listStoredSets(row.asset_id).find((set) => set.id === input.stemId)!
    return { subject: { type: 'stemSet', id: set.id, name: set.name }, recipe: set.recipe }
  }
  throw new Error(`Stem not found: ${input.stemId}`)
}

const getRecipeOp: Operation<z.infer<typeof recipeSubjectInput>> = {
  id: 'aurora_get_recipe',
  description: 'Free local read: exactly one assetId or stemId returns its stored recipe, subject name/type, readable text, reuse refusal and nearest reusable asset id. stemId accepts project stems, extraction stems or stored stem-set ids. Legacy rows expose what could be recovered and list missing facts. Nothing uploads or spends. Call aurora_copy_recipe for text, or aurora_reuse_prompt / aurora_reuse_reference to plan another take.',
  input: recipeSubjectInput,
  outputSchema: outputSchema(z.object({ subject: z.object({ type: z.enum(['asset', 'stem', 'extraction', 'stemSet']), id: z.string(), name: z.string() }),
    recipe: z.record(z.unknown()), text: z.string(), refusal: z.string().nullable(), reusableFrom: z.string().nullable() })),
  annotations: { title: 'Read recipe', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(input) {
    const found = findRecipe(input)
    const refusal = recipeRefusal(found.recipe)
    return ok({ ...found, text: recipeText(found.recipe, nameOfAsset), refusal,
      reusableFrom: reusableAncestor(found.recipe, recipeOfAsset)?.assetId ?? (refusal ? null : found.subject.id) })
  }
}

const copyRecipeOp: Operation<z.infer<typeof recipeSubjectInput>> = {
  id: 'aurora_copy_recipe',
  description: 'Free local read: exactly one assetId or stemId returns only text containing the complete readable recipe, source names, settings, cost and missing facts. Does not write the clipboard, upload or spend. Use aurora_get_recipe for structured provenance or aurora_reuse_prompt to plan a new take.',
  input: recipeSubjectInput,
  outputSchema: outputSchema(z.object({ text: z.string() })),
  annotations: { title: 'Copy recipe text', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(input) { return ok({ text: recipeText(findRecipe(input).recipe, nameOfAsset) }) }
}

function reusableRecipe(assetId: string): { recipe: Recipe; fromAssetId: string } {
  const { recipe } = findRecipe({ assetId })
  const ancestor = reusableAncestor(recipe, recipeOfAsset)
  if (!ancestor) throw new Error(recipeRefusal(recipe) ?? 'No reusable recipe was recorded')
  return { recipe: ancestor.recipe, fromAssetId: ancestor.assetId ?? assetId }
}

/** The app stores provider wire names; these three MCP adapters use different input names. */
function recipeReusePlan(recipe: Recipe, withReference: boolean): ReturnType<typeof reusePlan> {
  const plan = reusePlan(recipe, { withReference, knownModels: SUNO_MODELS, fallbackModel: DEFAULT_SUNO_MODEL })
  if (plan.call) {
    const args = plan.call.args
    if (args.model !== undefined) args.model = plan.fields.model
    if (args.vocalGender === null) delete args.vocalGender
    if (plan.call.op === 'aurora_generate' && args.prompt === undefined) args.prompt = plan.fields.prompt ?? ''
    if (plan.call.op === 'aurora_sounds') {
      if (args.soundTempo !== undefined) args.tempo = args.soundTempo
      if (args.soundLoop !== undefined) args.loop = args.soundLoop
      delete args.soundTempo; delete args.soundLoop
    }
    if (plan.call.op === 'aurora_replace_section') {
      if (args.tags === undefined && recipe.style) args.tags = recipe.style
      args.startS = args.infillStartS; args.endS = args.infillEndS
      delete args.infillStartS; delete args.infillEndS
    }
    if (plan.call.op === 'aurora_mashup') {
      if (args.sourceAssetId !== undefined) args.sourceAssetIdA = args.sourceAssetId
      if (args.sourcePath !== undefined) args.sourcePathA = args.sourcePath
      delete args.sourceAssetId; delete args.sourcePath
    }
  }
  return plan
}

const reuseInput = z.object({ assetId: z.string().min(1), loadInApp: z.boolean().default(true) }).strict()
const reuseCallSchema = z.object({ op: z.string(), args: z.record(z.unknown()) })
const reuseOutput = outputSchema(z.object({ loaded: z.boolean(), reason: z.string().optional(), call: reuseCallSchema.nullable(),
  fields: z.record(z.unknown()), notes: z.array(z.string()), acknowledgement: viewAckSchema.optional() }))

function reuseOperation(withReference: boolean): Operation<z.input<typeof reuseInput>> {
  const mode = withReference ? 'reference' : 'prompt'
  return {
    id: withReference ? 'aurora_reuse_reference' : 'aurora_reuse_prompt',
    description: `Free recipe reuse: assetId resolves its reusable recipe or nearest generation ancestor and returns the exact MCP call, composer fields and recovery notes. ${withReference ? 'Keeps the transform source audio as its reference.' : 'Reuses the words; transforms become song generation without their source audio.'} loadInApp defaults true: a connected desktop with composer-load loads Create and returns its acknowledgement; otherwise loaded:false includes the reason and plan. Never generates, uploads or spends. Inspect the plan, then call its target operation or aurora_make_variations with explicit confirmation.`,
    input: reuseInput,
    outputSchema: reuseOutput,
    annotations: { title: `Reuse ${mode}`, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(input, context) {
      const { recipe, fromAssetId } = reusableRecipe(input.assetId)
      const plan = recipeReusePlan(recipe, withReference)
      if (input.loadInApp === false) return ok({ loaded: false, reason: 'loadInApp is false', ...plan })
      try {
        const acknowledgement = await (context?.desktop?.() ?? new AuroraDesktopClient()).setView({ requestId: uuidv4(),
          patch: { page: 'create', composer: { fromAssetId, mode, fields: { ...plan.fields }, notes: plan.notes } } })
        return ok({ loaded: acknowledgement.status === 'applied',
          ...(acknowledgement.status === 'applied' ? {} : { reason: acknowledgement.reasons.join('; ') }),
          ...plan, acknowledgement })
      } catch (error) {
        if (!(error instanceof DesktopError)) throw error
        return ok({ loaded: false, reason: error.message, ...plan })
      }
    }
  }
}
const reusePromptOp = reuseOperation(false)
const reuseReferenceOp = reuseOperation(true)

const variationsInput = z.object({ assetId: z.string().min(1), count: z.number().int().min(1).max(5).default(1), confirm: z.boolean().optional() }).strict()
const makeVariationsOp: Operation<z.input<typeof variationsInput>> = {
  id: 'aurora_make_variations',
  description: 'Plan 1..5 Suno calls from assetId using its reusable recipe or generation ancestor with the source reference retained. count defaults 1; each Suno call returns two takes. Without confirm:true this is a free local plan returning planned count, exact call and estimated credits per call (unknown prices remain null). With confirm:true it spends credits by running that operation once per count, returns background job results and stops after any failure. Inspect aurora_get_recipe first; advance returned jobs with aurora_get_job_status rather than repeating this tool.',
  input: variationsInput,
  outputSchema: outputSchema(z.object({ planned: z.number().int(), call: reuseCallSchema,
    estimatedCredits: z.array(z.record(z.unknown())), note: z.string().optional(), results: z.array(objectData).optional() })),
  annotations: { title: 'Plan or make variations', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async run(input, context) {
    const { recipe } = reusableRecipe(input.assetId)
    const plan = recipeReusePlan(recipe, true)
    if (!plan.call) throw new Error('No reusable provider call was recorded')
    const count = input.count ?? 1
    const data = { planned: count, call: plan.call, estimatedCredits: Array.from({ length: count }, () => creditsFor(recipe.operation)) }
    if (input.confirm !== true) return ok({ ...data, note: 'Pass confirm: true to run' })
    const target = ALL_OPERATIONS.find((op) => op.id === plan.call!.op)
    if (!target) throw new Error(`Unknown recipe operation: ${plan.call.op}`)
    const args = target.input.parse({ ...plan.call.args, background: true })
    const results: OperationResult[] = []
    for (let i = 0; i < count; i++) {
      assertNotAborted(context)
      const result = await target.run(args, context)
      results.push(result)
      if (result.isError) break
    }
    return { ...ok({ ...data, results }), ...(results.some((result) => result.isError) ? { isError: true } : {}) }
  }
}

const getStemViewOp: Operation<{ assetId: string }> = {
  id: 'aurora_get_stem_view',
  annotations: { title: 'Read asset stem sets', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(stemViewSchema),
  description: 'Free local read: assetId returns the asset and separate split, extraction, imported and custom stem sets. Lanes include labels, drum groups, ordering and current file availability. No provider calls or writes. Choose one set at a time; combining sets would overlap audio. Use aurora_import_split_job or aurora_create_stem_set to register existing files.',
  input: z.object({ assetId: z.string().min(1).describe('Asset id from aurora_list_assets') }),
  async run(input) {
    const view = getStemView(input.assetId)
    return ok({ ...view }, `Found ${view.sets.length} stem sets for "${view.asset.name}".`)
  }
}

const stemSelectionShape = {
  assetId: z.string().min(1).describe('Asset id from aurora_list_assets'),
  setKey: z.string().min(1).describe('Exact split, extraction or set:<id> key from aurora_get_stem_view'),
  laneIds: z.array(z.string().min(1)).min(1).optional().describe('Exact laneIds from that set; omit for all lanes'),
  startSeconds: z.number().finite().min(0).optional().describe('Range start in seconds, default 0; rounded to nearest frame'),
  endSeconds: z.number().finite().positive().optional().describe('Exclusive range end; omit for full duration; rounded to nearest frame')
}
const measuredRangeSchema = z.object({
  startSeconds: z.number(), endSeconds: z.number(), startFrame: z.number().int(),
  endFrame: z.number().int(), frames: z.number().int()
})
const stemPeaksInput = z.object({ ...stemSelectionShape,
  laneIds: stemSelectionShape.laneIds.unwrap().max(16).optional(),
  points: z.number().int().min(1).max(2000).default(400).describe('Number of min/max bins per lane (1-2000, default 400)')
}).strict()
const getStemPeaksOp: Operation<z.input<typeof stemPeaksInput>> = {
  id: 'aurora_get_stem_peaks',
  annotations: { title: 'Read stem waveform peaks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: stemPeaksInput,
  outputSchema: outputSchema(z.object({ assetId: z.string(), setKey: z.string(), points: z.number().int(),
    lanes: z.array(z.object({ laneId: z.string(), sampleRate: z.number(), durationSeconds: z.number(),
      measuredRange: measuredRangeSchema, peaks: z.array(z.tuple([z.number().finite(), z.number().finite()])).max(2000) })).max(16) })),
  description: 'Free local waveform read without the desktop app: select assetId, one setKey and optional laneIds from aurora_get_stem_view. Returns exactly points [min,max] bins per lane over the requested range, native sampleRate and full-file durationSeconds. Default 400, maximum 2000 points and 16 lanes; larger selections are refused. Each frame uses the signed channel sample with greatest absolute amplitude (max-abs across channels); bins store its min/max without mono-sum cancellation. Empty bins repeat the nearest frame. Timing rounds to sample frames; invalid/out-of-file ranges and missing lanes fail. WAV is decoded locally; other audio uses bundled ffmpeg with no network. Use measure_stems for levels or export_stems for files.',
  async run(input) { return ok(await getStemPeaks({ ...input, points: input.points ?? 400 })) }
}
const measureStemsInput = z.object(stemSelectionShape).strict()
const measureStemsOp: Operation<z.infer<typeof measureStemsInput>> = {
  id: 'aurora_measure_stems',
  annotations: { title: 'Measure stem loudness', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: measureStemsInput,
  outputSchema: outputSchema(z.object({ assetId: z.string(), setKey: z.string(), lanes: z.array(z.object({
    laneId: z.string(), sampleRate: z.number(), samplePeakDbfs: z.number().finite().nullable(),
    rmsDbfs: z.number().finite().nullable(), integratedLufs: z.number().finite().nullable(),
    truePeakDbtp: z.number().finite().nullable(), silent: z.boolean(), measuredRange: measuredRangeSchema
  })) })),
  description: 'Free local mono/stereo stem measurement without the desktop app. Select assetId, one setKey and optional laneIds from aurora_get_stem_view; optional timing rounds to native-rate frames and must be inside each file. Returns sample peak (max across channels), RMS (mean channel energy), integrated LUFS per ITU-R BS.1770-4 (native-rate K-weighting, 400 ms blocks, 75% overlap, -70 LUFS absolute and -10 LU relative gates), and true peak from 4x 64-tap windowed-sinc oversampling with zero-padded edges. Digital silence has silent:true and null dB values, never -Infinity. LUFS is also null for ranges shorter than 400 ms or fully below the gates; silent stays false for nonzero audio. Surround is refused because channel roles are unavailable. No network, uploads or credit spend. Use export_stems to bake selected gains into a local mix.',
  async run(input) { return ok(await measureStems(input)) }
}
const exportStemsInput = z.object({ ...stemSelectionShape,
  mode: z.enum(['originals', 'mix', 'range']),
  gains: z.record(z.number().finite()).optional().describe('Mix only: selected laneId -> gain in dB (default 0); gain is baked in'),
  mutes: z.array(z.string().min(1)).optional().describe('Mix only: muted selected laneIds; solos override mutes'),
  solos: z.array(z.string().min(1)).optional().describe('Mix only: if nonempty, only these selected lanes play, even when muted'),
  outDir: z.string().min(1).describe('Absolute output directory; existing files are never overwritten')
}).strict()
const exportStemsOp: Operation<z.infer<typeof exportStemsInput>> = {
  id: 'aurora_export_stems',
  annotations: { title: 'Export local stem files', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  input: exportStemsInput,
  outputSchema: outputSchema(z.object({ manifestPath: z.string(), manifest: z.object({
    mode: z.enum(['originals', 'mix', 'range']), assetId: z.string(), setKey: z.string(),
    lanes: z.array(z.object({ laneId: z.string(), stemKey: z.string(), label: z.string(), sourcePath: z.string(),
      path: z.string(), audible: z.boolean(), gainDb: z.number(), sampleRate: z.number(), frames: z.number().int() })),
    range: measuredRangeSchema.nullable(), gainsApplied: z.record(z.number()), sampleRate: z.number().nullable(),
    frames: z.number().int().nullable(), paths: z.array(z.string()), peak: z.number().nullable(),
    peakDbfs: z.number().finite().nullable(), clipping: z.boolean()
  }) })),
  description: 'Free local file write without the desktop app: assetId, one setKey, mode and absolute outDir; select optional laneIds from aurora_get_stem_view. originals copies selected files byte-for-byte; range writes aligned per-lane 44.1 kHz float32 WAVs; mix sums audible lanes into one 44.1 kHz float32 WAV. Gain is baked in for mix. gains defaults 0 dB, mutes/solos empty; any solos form an exclusive set and override mute. These controls require mix; originals refuses timing. Range/mix share a nearest-frame start and length, defaulting to the longest selected lane; shorter lanes are zero-padded. Channels are preserved; mix duplicates mono into the common layout and otherwise requires matching channel counts. No limiter or normalisation: float headroom is retained, peak and clipping (>1) are reported for mix. Returns files and a written JSON manifest with lanes, applied gains, range, rate, frames and paths (originals has per-lane rates/lengths). Existing names receive suffixes using exclusive writes; repeating creates more files. No upload, spend or library mutation.',
  async run(input, context) { return ok(await exportStems(input, () => assertNotAborted(context))) }
}

const importSplitJobOp: Operation<{ jobJsonPath: string; assetId?: string; name?: string }> = {
  id: 'aurora_import_split_job',
  annotations: { title: 'Register bridge split job', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ set: storedSetSchema, reused: z.boolean(),
    skipped: z.array(z.object({ label: z.string(), path: z.string(), reason: z.string() })) })),
  description: 'Free local write: jobJsonPath registers a completed bridge split as an import set, referencing files in place. Never copies, re-splits or spends. Omit assetId to match args.input to a library asset. Legacy ee becomes Other and supersedes the non-bass other intermediate; original, instrumental, crash and ride are skipped with reasons. Reimporting the same manifest for an asset returns its existing set. Inspect with aurora_get_stem_view.',
  input: z.object({
    jobJsonPath: z.string().min(1).describe('Path to the completed bridge split job.json'),
    assetId: z.string().min(1).optional().describe('Target asset; otherwise match manifest args.input'),
    name: z.string().trim().min(1).optional().describe('Set name; defaults to the job folder name')
  }),
  async run(input) {
    const result = await importSplitJob(input)
    return ok({ ...result }, `${result.reused ? 'Reused' : 'Registered'} "${result.set.name}" with ${result.set.lanes.length} lanes; skipped ${result.skipped.length} overlapping or auxiliary outputs.`)
  }
}

const createStemSetOp: Operation<{ assetId: string; name: string; lanes: Array<{ stemKey: string; label?: string; path: string }> }> = {
  id: 'aurora_create_stem_set',
  annotations: { title: 'Register custom stem set', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  outputSchema: outputSchema(z.object({ set: storedSetSchema })),
  description: 'Free local write: assetId, name and lanes register a custom set of existing audio files in place. Each lane needs a unique stemKey and absolute existing path; optional label defaults to its split or extraction label, then stemKey. Input lane order is retained, with Other shown last. Never copies, moves, deletes files or spends credits. Sets are separate audio alternatives; inspect with aurora_get_stem_view.',
  input: z.object({ assetId: z.string().min(1), name: z.string().trim().min(1),
    lanes: z.array(z.object({ stemKey: z.string().trim().min(1), label: z.string().optional(),
      path: z.string().min(1).describe('Absolute path to an existing local audio file') })).min(1) }),
  async run(input) {
    const asset = getAsset(input.assetId)
    if (!asset) throw new Error(`Asset not found: ${input.assetId}`)
    const set = createStemSet({ projectId: asset.projectId, assetId: asset.id, kind: 'custom', name: input.name,
      recipe: localRecipe({ operation: 'stem-set', recordedBy: 'mcp', fromAssetId: asset.id,
        settings: { lanes: input.lanes.map((lane) => normalizeStemId(lane.stemKey)) },
        inputs: input.lanes.map((lane) => ({ role: 'source', path: lane.path })) }),
      lanes: input.lanes.map((lane) => {
        const stemKey = normalizeStemId(lane.stemKey)
        return { ...lane, stemKey, label: lane.label ?? STEM_LABELS[stemKey as StemType] ?? EXTRACT_STEM_LABELS[stemKey] ?? stemKey }
      }) })
    return ok({ set }, `Registered custom stem set "${set.name}" with ${set.lanes.length} lanes.`)
  }
}

const deleteStemSetOp: Operation<{ setId: string; confirm?: boolean }> = {
  id: 'aurora_delete_stem_set',
  annotations: { title: 'Delete stored stem set rows', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ deleted: z.string() })),
  description: 'Free destructive local write: setId and confirm:true remove an imported or custom stem set and its lane rows. Referenced files are never deleted. Split and extraction sets are derived and cannot be deleted with this operation. Read aurora_get_stem_view and strip the set: prefix to get setId. Without confirmation returns CONFIRMATION_REQUIRED.',
  input: z.object({ setId: z.string().min(1),
    confirm: z.boolean().optional().describe('Must be true. Confirm the row deletion with the user before calling.') }),
  async run(input) {
    if (!input.confirm) throw new Error(`Confirmation required: confirm:true deletes stored stem set ${input.setId} and its lane rows; files remain.`)
    deleteStemSet(input.setId)
    return ok({ deleted: input.setId }, `Deleted stem set ${input.setId}; referenced files remain.`)
  }
}

const fetchWavOp: Operation<{ assetId: string }> = {
  id: 'aurora_fetch_wav',
  annotations: { title: 'Fetch provider WAV', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  outputSchema: outputSchema(z.object({ asset: assetSchema })),
  description: "PAID Suno conversion: required assetId must contain provider taskId/audioId. Requests and downloads provider WAV, then updates asset path while retaining MP3. Returns updated asset. No source re-upload. For a free local format conversion use aurora_convert; inspect aurora_list_assets afterward.",
  input: z.object({ assetId: z.string() }),
  async run(input, context) {
    const asset = getAsset(input.assetId)
    if (!asset) throw new Error(`Asset not found: ${input.assetId}`)
    const origin = (asset.origin ?? {}) as { taskId?: string; audioId?: string | null }
    if (!origin.taskId || !origin.audioId) {
      throw new Error(
        'This asset has no provider taskId/audioId in its origin metadata (probably an import, or a ' +
          'legacy generation) — the provider WAV conversion needs both. Use aurora_convert for a local ffmpeg WAV instead.'
      )
    }
    assertNotAborted(context)
    const wavTaskId = await createWavConversion(origin.taskId, origin.audioId)
    assertNotAborted(context)
    const wavUrl = await pollWavConversion(wavTaskId)
    const wavPath = join(dirname(asset.path), `${basename(asset.path, extname(asset.path))}.wav`)
    assertNotAborted(context)
    await downloadTo(wavUrl, wavPath)
    const updated = updateAssetPath(asset.id, wavPath)
    return ok({ asset: updated }, `WAV fetched: ${wavPath} (asset re-pointed; MP3 kept on disk).`)
  }
}

// ── Generation (long ops — background-capable) ──────────────────

// Shared knob schemas — the schema IS the agent's manual (param-table contract:
// docs/suno-param-surface.md, verified vs live docs 2026-06-10).
const styleWeightSchema = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe('0..1 — how hard the output follows the style text. ~0.55-0.75 for layering work')
const weirdnessSchema = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe('0..1 — creative deviation/novelty. Low (0.2-0.4) = predictable takes, high = surprises')
const audioWeightSchema = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe('0..1 — input-audio influence on audio-conditioned ops. 0.7-0.85 locks tempo/harmony to the upload')
const personaIdSchema = z
  .string()
  .optional()
  .describe('Persona id or Suno Voice voiceId — keeps a consistent vocal character across generations (custom mode only)')
const personaModelSchema = z
  .enum(['style_persona', 'voice_persona'])
  .optional()
  .describe('style_persona (default) | voice_persona (set when personaId is a Suno Voice voiceId; V5_5 and the V6 family)')

const generateOp: Operation<{
  prompt: string
  customMode?: boolean
  style?: string
  title?: string
  instrumental?: boolean
  model?: string
  duration?: number
  variety?: number
  vocalGender?: 'male' | 'female'
  negativeTags?: string
  styleWeight?: number
  weirdnessConstraint?: number
  audioWeight?: number
  personaId?: string
  personaModel?: 'style_persona' | 'voice_persona'
  projectId?: string
  trackId?: string
  background?: boolean
}> = {
  id: 'aurora_generate',
  annotations: { title: 'Generate music', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  outputSchema: outputSchema(jobSchema),
  description: "PAID Suno music generation from prompt. Optional style/title enable custom mode; instrumental defaults false, model uses the provider default, variety uses provider default when omitted. Optional projectId/trackId choose landing, otherwise creates a project. background defaults false: wait with progress; true returns a durable job. Returns job state, asset ids and preview URLs. Advance aurora_get_job_status; do not repeat paid submissions to poll.",
  input: z.object({
    prompt: z
      .string()
      .describe(
        'Custom mode: the EXACT lyrics sung verbatim (≤5000 chars on V4_5 and later; supports [Verse]/[Chorus]/[Choir]/[Instrumental] metatags; ignored when instrumental). ' +
          'Non-custom mode: a ≤500-char track description — Suno writes its own lyrics'
      ),
    customMode: z
      .boolean()
      .optional()
      .describe(
        'true = full control (style + title REQUIRED, prompt = literal lyrics). false = description-only mode. ' +
          'Default: true when style or title is set. Prefer custom mode — it is the whole point of this surface'
      ),
    style: z
      .string()
      .optional()
      .describe('Music style text (≤1000 chars on V4_5 and later). Required in custom mode'),
    title: z.string().optional().describe('Track title (≤100 chars). Required in custom mode'),
    instrumental: z.boolean().optional().describe('Generate without vocals (default false)'),
    model: z.string().optional().describe(MODEL_DESCRIBE),
    duration: durationSchema,
    variety: varietySchema,
    vocalGender: z.enum(['male', 'female']).optional(),
    negativeTags: z
      .string()
      .optional()
      .describe('Styles/instruments to exclude, ONE comma-separated string, e.g. "drums, percussion, orchestra". More reliable than "no X" in the style text'),
    styleWeight: styleWeightSchema,
    weirdnessConstraint: weirdnessSchema,
    audioWeight: audioWeightSchema,
    personaId: personaIdSchema,
    personaModel: personaModelSchema,
    projectId: z.string().optional().describe('Target project (auto-created from the title/prompt when omitted)'),
    trackId: landingTrackIdSchema,
    background: z.boolean().optional().describe('Return a jobId immediately instead of waiting')
  }),
  async run(input, context) {
    const customMode = input.customMode ?? Boolean(input.style || input.title)
    if (customMode && (!input.style || !input.title)) {
      throw new Error('Custom mode requires BOTH style and title (lyrics go in prompt).')
    }
    if (!customMode && input.prompt.length > 500) {
      throw new Error(
        'Non-custom prompts cap at 500 chars (it is a description, not lyrics). For literal lyrics set customMode true + style + title.'
      )
    }
    const model = normalizeModel(input.model, DEFAULT_GEN_MODEL)
    assertDurationUsable(input.duration, model, customMode)
    const baseName = input.title?.trim() || input.prompt.slice(0, 60).trim() || 'Generated track'
    const projectId = await resolveProjectOrCreate(input.projectId, baseName)
    const trackId = resolveLandingTrack(projectId, input.trackId)

    assertNotAborted(context)
    const taskId = await createGeneration({
      prompt: input.prompt,
      style: input.style,
      title: input.title,
      instrumental: input.instrumental ?? false,
      customMode,
      model,
      duration: input.duration,
      variety: input.variety,
      vocalGender: input.vocalGender,
      negativeTags: input.negativeTags,
      styleWeight: input.styleWeight,
      weirdnessConstraint: input.weirdnessConstraint,
      audioWeight: input.audioWeight,
      personaId: input.personaId,
      personaModel: input.personaModel
    })

    const manifest = newJobManifest(
      'generate',
      `gen-${uuidv4().slice(0, 8)}`,
      projectId,
      baseName,
      {
        prompt: input.prompt,
        customMode,
        style: input.style,
        title: input.title,
        instrumental: input.instrumental ?? false,
        model,
        duration: input.duration,
        variety: input.variety,
        vocalGender: input.vocalGender ?? null,
        negativeTags: input.negativeTags,
        styleWeight: input.styleWeight,
        weirdnessConstraint: input.weirdnessConstraint,
        audioWeight: input.audioWeight,
        personaId: input.personaId,
        personaModel: input.personaModel
      },
      { taskId }
    )
    manifest.trackId = trackId
    await saveJob(manifest)

    if (input.background) {
      return ok(jobSummary(manifest), jobText(manifest))
    }
    const finished = await awaitJob(manifest, context)
    return ok(jobSummary(finished), jobText(finished))
  }
}

const soundsOp: Operation<{
  prompt: string
  soundKey?: string
  tempo?: number
  loop?: boolean
  grabLyrics?: boolean
  model?: string
  projectId?: string
  trackId?: string
  background?: boolean
}> = {
  id: 'aurora_sounds',
  annotations: { title: 'Generate sound', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  outputSchema: outputSchema(jobSchema),
  description: "PAID Suno sound generation from required prompt. Optional model uses provider default; projectId/trackId choose landing, otherwise creates a project. background defaults false: wait with progress; true returns a durable job. Returns job state and downloaded asset ids. Advance aurora_get_job_status, then list assets.",
  input: z.object({
    prompt: z.string().max(500).describe('Sound description, e.g. "huge cinematic braam, dark low brass"'),
    soundKey: z.string().optional().describe('Pitch lock: C..B major or Cm..Bm minor, sharps as C# (default Any)'),
    tempo: z.number().int().min(1).max(300).optional().describe('BPM lock; omit for auto'),
    loop: z.boolean().optional().describe('Generate as a loopable sound'),
    grabLyrics: z.boolean().optional().describe('Also capture lyric subtitles when the sound has vocals'),
    model: z.string().optional().describe(MODEL_DESCRIBE),
    projectId: z.string().optional(),
    trackId: landingTrackIdSchema,
    background: z.boolean().optional()
  }),
  async run(input, context) {
    const baseName = input.prompt.slice(0, 60).trim() || 'Sound'
    const projectId = await resolveProjectOrCreate(input.projectId, baseName)
    const trackId = resolveLandingTrack(projectId, input.trackId)
    const model = normalizeModel(input.model, DEFAULT_GEN_MODEL)

    assertNotAborted(context)
    const taskId = await createSoundsGeneration({
      prompt: input.prompt,
      soundKey: input.soundKey,
      soundTempo: input.tempo,
      soundLoop: input.loop,
      grabLyrics: input.grabLyrics,
      model
    })

    const manifest = newJobManifest(
      'sounds',
      `snd-${uuidv4().slice(0, 8)}`,
      projectId,
      baseName,
      {
        prompt: input.prompt,
        instrumental: true,
        model,
        soundKey: input.soundKey,
        soundTempo: input.tempo,
        soundLoop: input.loop ?? false,
        grabLyrics: input.grabLyrics ?? false
      },
      { taskId }
    )
    manifest.trackId = trackId
    await saveJob(manifest)

    if (input.background) {
      return ok(jobSummary(manifest), jobText(manifest))
    }
    const finished = await awaitJob(manifest, context)
    return ok(jobSummary(finished), jobText(finished))
  }
}

/** AIFF/FLAC → standardized WAV for upload (undocumented containers), then the
 *  provider File Upload API. The temp file is disposable the moment the upload
 *  returns — cleaned on every path (the leak here was a fresh-eyes review
 *  finding). Shared by cover / add-vocals / add-instrumental. */
async function uploadSourceAudio(sourcePath: string): Promise<string> {
  let tempUpload: string | null = null
  try {
    let uploadSource = sourcePath
    const ext = extname(sourcePath).toLowerCase()
    if (ext !== '.wav' && ext !== '.mp3') {
      const { tmpdir } = await import('node:os')
      tempUpload = join(tmpdir(), `aurora-upload-${Date.now()}.wav`)
      await standardizeToWav(sourcePath, tempUpload)
      uploadSource = tempUpload
    }
    return await uploadAudioFile(uploadSource)
  } finally {
    if (tempUpload) {
      const { rm } = await import('node:fs/promises')
      await rm(tempUpload, { force: true }).catch(() => {})
    }
  }
}

/** Resolve a layering-op source to a local file path (asset or external). */
function resolveSourcePath(input: { sourceAssetId?: string; sourcePath?: string }): {
  sourcePath: string
  sourceAsset: ProjectAsset | null
} {
  const sourceAsset = input.sourceAssetId ? getAsset(input.sourceAssetId) : null
  if (input.sourceAssetId && !sourceAsset) throw new Error(`Asset not found: ${input.sourceAssetId}`)
  const sourcePath = sourceAsset?.path ?? input.sourcePath
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error('Source not found — pass sourceAssetId (a project asset) or sourcePath (a file).')
  }
  return { sourcePath, sourceAsset }
}

const coverOp: Operation<{
  sourceAssetId?: string
  sourcePath?: string
  prompt: string
  customMode?: boolean
  style?: string
  title?: string
  instrumental?: boolean
  model?: string
  duration?: number
  variety?: number
  vocalGender?: 'male' | 'female'
  negativeTags?: string
  audioWeight?: number
  styleWeight?: number
  weirdnessConstraint?: number
  personaId?: string
  personaModel?: 'style_persona' | 'voice_persona'
  projectId?: string
  trackId?: string
  background?: boolean
  fetchWav?: boolean
}> = {
  id: 'aurora_cover',
  annotations: { title: 'Cover uploaded audio', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  outputSchema: outputSchema(jobSchema),
  description: "PAID Suno cover: provide sourceAssetId or sourcePath plus prompt; uploads audio (8-minute cap), style/title enable custom mode, model uses provider default, instrumental defaults false. Suno's own recordings may be refused by upload; use extend/replace_section id routes for those. Optional projectId/trackId select landing. background defaults false with best-effort paid WAV fetch enabled; true lands MP3 only. Returns job/assets and WAV notes. Advance aurora_get_job_status or retry WAV via aurora_fetch_wav.",
  input: z.object({
    sourceAssetId: z.string().optional().describe('Project asset to transform'),
    sourcePath: z.string().optional().describe('OR an external audio file path'),
    prompt: z.string().describe('Custom mode: exact lyrics. Non-custom: what the cover should sound like (≤500 chars)'),
    customMode: z
      .boolean()
      .optional()
      .describe('true = style + title required, prompt = literal lyrics. Default: true when style or title is set'),
    style: z.string().optional().describe('Target style (custom mode needs BOTH style and title; ≤1000 chars on V4_5 and later)'),
    title: z.string().optional(),
    instrumental: z.boolean().optional(),
    model: z.string().optional().describe(`${MODEL_DESCRIBE}. V4_5ALL caps input at 1 min`),
    duration: durationSchema,
    variety: varietySchema,
    vocalGender: z.enum(['male', 'female']).optional(),
    negativeTags: z.string().optional().describe('Styles/instruments to exclude, ONE comma-separated string'),
    audioWeight: z.number().min(0).max(1).optional().describe('0..1 — 0 = new style dominates, 1 = stay close to the source. 0.7-0.85 = structure locked, timbre swapped'),
    styleWeight: styleWeightSchema,
    weirdnessConstraint: weirdnessSchema,
    personaId: personaIdSchema,
    personaModel: personaModelSchema,
    projectId: z.string().optional(),
    trackId: landingTrackIdSchema,
    background: z.boolean().optional(),
    fetchWav: z
      .boolean()
      .optional()
      .describe('Blocking mode only: also fetch the provider WAV per variation (default true; ~0.4 credits each)')
  }),
  async run(input, context) {
    const sourceAsset = input.sourceAssetId ? getAsset(input.sourceAssetId) : null
    if (input.sourceAssetId && !sourceAsset) throw new Error(`Asset not found: ${input.sourceAssetId}`)
    const sourcePath = sourceAsset?.path ?? input.sourcePath
    if (!sourcePath || !existsSync(sourcePath)) {
      throw new Error('Cover source not found — pass sourceAssetId (a project asset) or sourcePath (a file).')
    }

    const customMode = input.customMode ?? Boolean(input.style || input.title)
    if (customMode && (!input.style || !input.title)) {
      throw new Error('Custom mode needs BOTH a style and a title (you set only one).')
    }
    const model = normalizeModel(input.model, DEFAULT_GEN_MODEL)
    assertDurationUsable(input.duration, model, customMode)

    // 8-minute reference cap (pre-checked; the provider enforces it too).
    const duration = await probeDurationSeconds(sourcePath)
    if (duration !== null && duration > MAX_COVER_REFERENCE_SECONDS) {
      throw new Error(
        `Reference audio is ${Math.round(duration)}s — covers cap the input at 8 minutes. Export a shorter section.`
      )
    }

    const baseName = input.title?.trim() || `${basename(sourcePath, extname(sourcePath))} cover`.trim()
    const projectId = await resolveDerivedProject(input.projectId, sourceAsset, baseName)

    const trackId = resolveLandingTrack(projectId, input.trackId)
    assertNotAborted(context)
    const uploadUrl = await uploadSourceAudio(sourcePath)
    assertNotAborted(context)
    const taskId = await createCover({
      uploadUrl,
      prompt: input.prompt,
      style: input.style,
      title: input.title,
      instrumental: input.instrumental ?? false,
      customMode,
      model,
      duration: input.duration,
      variety: input.variety,
      vocalGender: input.vocalGender,
      negativeTags: input.negativeTags,
      audioWeight: input.audioWeight,
      styleWeight: input.styleWeight,
      weirdnessConstraint: input.weirdnessConstraint,
      personaId: input.personaId,
      personaModel: input.personaModel
    })

    const manifest = newJobManifest(
      'cover',
      `cov-${uuidv4().slice(0, 8)}`,
      projectId,
      baseName,
      {
        prompt: input.prompt,
        customMode,
        style: input.style,
        title: input.title,
        instrumental: input.instrumental ?? false,
        model,
        duration: input.duration,
        variety: input.variety,
        vocalGender: input.vocalGender ?? null,
        negativeTags: input.negativeTags,
        audioWeight: input.audioWeight,
        styleWeight: input.styleWeight,
        weirdnessConstraint: input.weirdnessConstraint,
        personaId: input.personaId,
        personaModel: input.personaModel
      },
      { taskId, sourceAssetId: sourceAsset?.id ?? null }
    )
    manifest.params.sourcePath = sourceAsset ? null : sourcePath
    manifest.trackId = trackId
    await saveJob(manifest)

    if (input.background) {
      return ok(jobSummary(manifest), jobText(manifest))
    }

    const finished = await awaitJob(manifest, context)

    // Blocking-mode WAV stage (mirrors the app's runCover best-effort WAVs).
    const wavNotes: string[] = []
    if ((finished.status === 'done' || finished.status === 'completed') && (input.fetchWav ?? true)) {
      for (const assetId of finished.assetIds) {
        try {
          assertNotAborted(context)
          await fetchWavOp.run({ assetId }, context)
          wavNotes.push(`${assetId}: WAV fetched`)
        } catch (err) {
          wavNotes.push(`${assetId}: WAV failed (${err instanceof Error ? err.message : err}) — MP3 kept; retry with aurora_fetch_wav`)
        }
      }
    }
    const summary = jobSummary(finished)
    if (wavNotes.length > 0) (summary as Record<string, unknown>).wavStage = wavNotes
    return ok(summary, `${jobText(finished)}${wavNotes.length > 0 ? ` WAV stage: ${wavNotes.join('; ')}` : ''}`)
  }
}

const addVocalsOp: Operation<{
  sourceAssetId?: string
  sourcePath?: string
  prompt: string
  style: string
  title: string
  negativeTags: string
  vocalGender?: 'male' | 'female'
  styleWeight?: number
  weirdnessConstraint?: number
  audioWeight?: number
  model?: string
  projectId?: string
  trackId?: string
  background?: boolean
  fetchWav?: boolean
}> = {
  id: 'aurora_add_vocals',
  annotations: { title: 'Add generated vocals', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  outputSchema: outputSchema(jobSchema),
  description: "PAID Suno vocals over uploaded instrumental: sourceAssetId or sourcePath, prompt, style, title and negativeTags are required; optional model/controls refine the result. Project defaults to the source project or a new project for file input; trackId defaults to the project root. background defaults false; true returns a durable job. Blocking fetchWav defaults true and adds conversion spend. Returns job, asset ids and WAV notes. Advance aurora_get_job_status; inspect assets afterward.",
  input: z.object({
    sourceAssetId: z.string().optional().describe('Project asset to sing over'),
    sourcePath: z.string().optional().describe('OR an external audio file path'),
    prompt: z
      .string()
      .describe('Vocal content + direction — lyrics or syllables (e.g. Latin chant for choir) with [Choir]/[Harmony] metatags'),
    style: z
      .string()
      .describe('Vocal approach, e.g. "epic film choir, massed choral harmonies, latin chant" (this is what steers choir vs lead singer)'),
    title: z.string().max(100).describe('Track title (≤100 chars)'),
    negativeTags: z
      .string()
      .describe('Vocal styles to exclude, ONE comma-separated string, e.g. "lead singer, pop vocal, rap, spoken word, autotune"'),
    vocalGender: z.enum(['male', 'female']).optional(),
    styleWeight: styleWeightSchema,
    weirdnessConstraint: weirdnessSchema,
    audioWeight: audioWeightSchema,
    model: z.string().optional().describe(MODEL_DESCRIBE),
    projectId: z.string().optional(),
    trackId: landingTrackIdSchema,
    background: z.boolean().optional(),
    fetchWav: z.boolean().optional().describe('Blocking mode only: also fetch the provider WAV per variation (default true)')
  }),
  async run(input, context) {
    const { sourcePath, sourceAsset } = resolveSourcePath(input)
    const model = normalizeModel(input.model, DEFAULT_GEN_MODEL)
    const baseName = input.title.trim() || `${basename(sourcePath, extname(sourcePath))} vocals`
    const projectId = await resolveDerivedProject(input.projectId, sourceAsset, baseName)

    const trackId = resolveLandingTrack(projectId, input.trackId)
    assertNotAborted(context)
    const uploadUrl = await uploadSourceAudio(sourcePath)
    assertNotAborted(context)
    const taskId = await createAddVocals({
      uploadUrl,
      prompt: input.prompt,
      style: input.style,
      title: input.title,
      negativeTags: input.negativeTags,
      vocalGender: input.vocalGender,
      styleWeight: input.styleWeight,
      weirdnessConstraint: input.weirdnessConstraint,
      audioWeight: input.audioWeight,
      model
    })

    const manifest = newJobManifest(
      'add_vocals',
      `avo-${uuidv4().slice(0, 8)}`,
      projectId,
      baseName,
      {
        op: 'add_vocals',
        prompt: input.prompt,
        style: input.style,
        title: input.title,
        negativeTags: input.negativeTags,
        vocalGender: input.vocalGender ?? null,
        styleWeight: input.styleWeight,
        weirdnessConstraint: input.weirdnessConstraint,
        audioWeight: input.audioWeight,
        model,
        instrumental: false
      },
      { taskId, sourceAssetId: sourceAsset?.id ?? null }
    )
    manifest.params.sourcePath = sourceAsset ? null : sourcePath
    manifest.trackId = trackId
    await saveJob(manifest)

    if (input.background) {
      return ok(jobSummary(manifest), jobText(manifest))
    }
    const finished = await awaitJob(manifest, context)

    const wavNotes: string[] = []
    if ((finished.status === 'done' || finished.status === 'completed') && (input.fetchWav ?? true)) {
      for (const assetId of finished.assetIds) {
        try {
          assertNotAborted(context)
          await fetchWavOp.run({ assetId }, context)
          wavNotes.push(`${assetId}: WAV fetched`)
        } catch (err) {
          wavNotes.push(`${assetId}: WAV failed (${err instanceof Error ? err.message : err}) — MP3 kept; retry with aurora_fetch_wav`)
        }
      }
    }
    const summary = jobSummary(finished)
    if (wavNotes.length > 0) (summary as Record<string, unknown>).wavStage = wavNotes
    return ok(
      summary,
      `${jobText(finished)}${wavNotes.length > 0 ? ` WAV stage: ${wavNotes.join('; ')}` : ''}` +
        ((finished.status === 'done' || finished.status === 'completed')
          ? ' Next for layering: aurora_split the result and keep the vocals stem.'
          : '')
    )
  }
}

const addInstrumentalOp: Operation<{
  sourceAssetId?: string
  sourcePath?: string
  title: string
  tags: string
  negativeTags: string
  vocalGender?: 'male' | 'female'
  styleWeight?: number
  weirdnessConstraint?: number
  audioWeight?: number
  model?: string
  projectId?: string
  trackId?: string
  background?: boolean
  fetchWav?: boolean
}> = {
  id: 'aurora_add_instrumental',
  annotations: { title: 'Add generated instrumental', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  outputSchema: outputSchema(jobSchema),
  description: "PAID Suno accompaniment for uploaded vocals: sourceAssetId or sourcePath plus required tags, title and negativeTags; optional model/controls refine it. Project defaults to the source project or a new project for file input; trackId defaults to the project root. background defaults false; true returns a durable job. fetchWav defaults true and adds conversion spend in blocking mode. Returns job, downloaded assets and WAV notes. Advance aurora_get_job_status next.",
  input: z.object({
    sourceAssetId: z.string().optional().describe('Project asset to build instrumentation around'),
    sourcePath: z.string().optional().describe('OR an external audio file path'),
    title: z.string().max(100).describe('Track title (≤100 chars)'),
    tags: z
      .string()
      .describe('Desired instrumental style/mood/instruments (this endpoint names the field tags, comma-separated)'),
    negativeTags: z.string().describe('Styles/instruments to exclude, ONE comma-separated string'),
    vocalGender: z.enum(['male', 'female']).optional(),
    styleWeight: styleWeightSchema,
    weirdnessConstraint: weirdnessSchema,
    audioWeight: audioWeightSchema,
    model: z.string().optional().describe(MODEL_DESCRIBE),
    projectId: z.string().optional(),
    trackId: landingTrackIdSchema,
    background: z.boolean().optional(),
    fetchWav: z.boolean().optional().describe('Blocking mode only: also fetch the provider WAV per variation (default true)')
  }),
  async run(input, context) {
    const { sourcePath, sourceAsset } = resolveSourcePath(input)
    const model = normalizeModel(input.model, DEFAULT_GEN_MODEL)
    const baseName = input.title.trim() || `${basename(sourcePath, extname(sourcePath))} instrumental`
    const projectId = await resolveDerivedProject(input.projectId, sourceAsset, baseName)
    const trackId = resolveLandingTrack(projectId, input.trackId)

    assertNotAborted(context)
    const uploadUrl = await uploadSourceAudio(sourcePath)
    assertNotAborted(context)
    const taskId = await createAddInstrumental({
      uploadUrl,
      title: input.title,
      tags: input.tags,
      negativeTags: input.negativeTags,
      vocalGender: input.vocalGender,
      styleWeight: input.styleWeight,
      weirdnessConstraint: input.weirdnessConstraint,
      audioWeight: input.audioWeight,
      model
    })

    const manifest = newJobManifest(
      'add_instrumental',
      `ain-${uuidv4().slice(0, 8)}`,
      projectId,
      baseName,
      {
        op: 'add_instrumental',
        title: input.title,
        tags: input.tags,
        negativeTags: input.negativeTags,
        vocalGender: input.vocalGender ?? null,
        styleWeight: input.styleWeight,
        weirdnessConstraint: input.weirdnessConstraint,
        audioWeight: input.audioWeight,
        model,
        instrumental: true
      },
      { taskId, sourceAssetId: sourceAsset?.id ?? null }
    )
    manifest.params.sourcePath = sourceAsset ? null : sourcePath
    manifest.trackId = trackId
    await saveJob(manifest)

    if (input.background) {
      return ok(jobSummary(manifest), jobText(manifest))
    }
    const finished = await awaitJob(manifest, context)

    const wavNotes: string[] = []
    if ((finished.status === 'done' || finished.status === 'completed') && (input.fetchWav ?? true)) {
      for (const assetId of finished.assetIds) {
        try {
          assertNotAborted(context)
          await fetchWavOp.run({ assetId }, context)
          wavNotes.push(`${assetId}: WAV fetched`)
        } catch (err) {
          wavNotes.push(`${assetId}: WAV failed (${err instanceof Error ? err.message : err}) — MP3 kept; retry with aurora_fetch_wav`)
        }
      }
    }
    const summary = jobSummary(finished)
    if (wavNotes.length > 0) (summary as Record<string, unknown>).wavStage = wavNotes
    return ok(summary, `${jobText(finished)}${wavNotes.length > 0 ? ` WAV stage: ${wavNotes.join('; ')}` : ''}`)
  }
}

// ── v6-era ops: extend / replace-section / mashup ───────────────
// All three land through the generation job path (record-info poll). Wire
// shapes: docs/suno-param-surface.md (verified 2026-09-14).

/** Blocking-mode tail shared by the source-derived ops: optional WAV stage +
 *  summary text. */
async function finishDerivedJob(
  manifest: JobManifest,
  input: { background?: boolean; fetchWav?: boolean },
  context?: OperationContext
): Promise<OperationResult> {
  if (input.background) return ok(jobSummary(manifest), jobText(manifest))
  const finished = await awaitJob(manifest, context)
  const wavNotes: string[] = []
  if ((finished.status === 'done' || finished.status === 'completed') && (input.fetchWav ?? false)) {
    for (const assetId of finished.assetIds) {
      try {
        assertNotAborted(context)
          await fetchWavOp.run({ assetId }, context)
        wavNotes.push(`${assetId}: WAV fetched`)
      } catch (err) {
        wavNotes.push(`${assetId}: WAV failed (${err instanceof Error ? err.message : err}) — MP3 kept; retry with aurora_fetch_wav`)
      }
    }
  }
  const summary = jobSummary(finished)
  if (wavNotes.length > 0) (summary as Record<string, unknown>).wavStage = wavNotes
  return ok(summary, `${jobText(finished)}${wavNotes.length > 0 ? ` WAV stage: ${wavNotes.join('; ')}` : ''}`)
}

/** Project for a derived op: explicit id → the source asset's project → a new one. */
async function resolveDerivedProject(projectId: string | undefined, sourceAsset: ProjectAsset | null, baseName: string): Promise<string> {
  if (projectId) {
    const p = getProject(projectId)
    if (!p) throw new Error(`Project not found: ${projectId}`)
    return p.id
  }
  return sourceAsset?.projectId ?? (await createProject(baseName)).id
}

/** Provider ids a Suno-generated asset carries in its origin (landed by both
 *  the app and the MCP). Null when the asset was imported or split. */
function sunoIdsOf(asset: ProjectAsset | null): { taskId: string; audioId: string } | null {
  const o = asset?.origin as { taskId?: unknown; audioId?: unknown } | null | undefined
  const taskId = typeof o?.taskId === 'string' ? o.taskId : null
  const audioId = typeof o?.audioId === 'string' ? o.audioId : null
  return taskId && audioId ? { taskId, audioId } : null
}

const extendOp: Operation<{
  sourceAssetId?: string
  sourcePath?: string
  continueAt?: number
  prompt?: string
  style?: string
  title?: string
  instrumental?: boolean
  model?: string
  vocalGender?: 'male' | 'female'
  negativeTags?: string
  styleWeight?: number
  weirdnessConstraint?: number
  audioWeight?: number
  personaId?: string
  personaModel?: 'style_persona' | 'voice_persona'
  projectId?: string
  trackId?: string
  background?: boolean
  fetchWav?: boolean
}> = {
  id: 'aurora_extend',
  annotations: { title: 'Extend audio', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  outputSchema: outputSchema(jobSchema),
  description: "PAID Suno continuation: sourceAssetId or sourcePath; provider ids choose an id-based route, otherwise audio uploads. Optional prompt/style/title, continueAt and provider controls use schema defaults. Project follows source unless specified; trackId defaults to project root. background defaults false; fetchWav defaults false and adds paid conversion if enabled. Returns durable job and landed assets linked to source. Advance aurora_get_job_status rather than resubmit.",
  input: z.object({
    sourceAssetId: z.string().optional().describe('Project asset to continue'),
    sourcePath: z.string().optional().describe('OR an external audio file path (upload-extend route)'),
    continueAt: z
      .number()
      .min(0)
      .optional()
      .describe('Seconds into the source where the continuation starts. Required in custom mode; must be < source length'),
    prompt: z.string().optional().describe('Custom mode: exact lyrics for the new section (omit when instrumental)'),
    style: z.string().optional().describe('Custom mode: style for the continuation (≤1000 chars). Set with title'),
    title: z.string().optional().describe('Custom mode: title (≤100 chars). Set with style'),
    instrumental: z.boolean().optional(),
    model: z.string().optional().describe(MODEL_DESCRIBE),
    vocalGender: z.enum(['male', 'female']).optional(),
    negativeTags: z.string().optional().describe('Styles/instruments to exclude, ONE comma-separated string'),
    styleWeight: styleWeightSchema,
    weirdnessConstraint: weirdnessSchema,
    audioWeight: audioWeightSchema,
    personaId: personaIdSchema,
    personaModel: personaModelSchema,
    projectId: z.string().optional(),
    trackId: landingTrackIdSchema,
    background: z.boolean().optional(),
    fetchWav: z.boolean().optional().describe('Blocking mode only: fetch the provider WAV per variation (default false; ~0.4 credits each)')
  }),
  async run(input, context) {
    const customMode = Boolean(input.style || input.title)
    if (customMode && (!input.style || !input.title)) {
      throw new Error('Custom mode needs BOTH a style and a title (you set only one).')
    }
    if (customMode && input.continueAt === undefined) {
      throw new Error('Custom mode needs continueAt (seconds into the source to continue from).')
    }
    const model = normalizeModel(input.model, DEFAULT_GEN_MODEL)
    const { sourcePath, sourceAsset } = resolveSourcePath(input)
    const ids = sunoIdsOf(sourceAsset)
    const baseName = input.title?.trim() || `${basename(sourcePath, extname(sourcePath))} extended`
    const projectId = await resolveDerivedProject(input.projectId, sourceAsset, baseName)
    const trackId = resolveLandingTrack(projectId, input.trackId)

    const shared = {
      defaultParamFlag: customMode,
      model,
      instrumental: input.instrumental,
      prompt: input.prompt,
      style: input.style,
      title: input.title,
      continueAt: input.continueAt,
      vocalGender: input.vocalGender,
      negativeTags: input.negativeTags,
      styleWeight: input.styleWeight,
      weirdnessConstraint: input.weirdnessConstraint,
      audioWeight: input.audioWeight,
      personaId: input.personaId,
      personaModel: input.personaModel
    }

    let taskId: string
    let route: 'extend' | 'upload-extend'
    if (ids) {
      route = 'extend'
      assertNotAborted(context)
      taskId = await createExtend({ ...shared, audioId: ids.audioId, taskId: ids.taskId })
    } else {
      route = 'upload-extend'
      const duration = await probeDurationSeconds(sourcePath)
      if (duration !== null && duration > MAX_COVER_REFERENCE_SECONDS) {
        throw new Error(`Source is ${Math.round(duration)}s — upload-extend caps the input at 8 minutes.`)
      }
      if (duration !== null && input.continueAt !== undefined && input.continueAt >= duration) {
        throw new Error(`continueAt (${input.continueAt}s) must be inside the source (${Math.round(duration)}s).`)
      }
      assertNotAborted(context)
      const uploadUrl = await uploadSourceAudio(sourcePath)
      assertNotAborted(context)
      taskId = await createUploadExtend({ ...shared, uploadUrl })
    }

    const manifest = newJobManifest(
      'extend',
      `xtd-${uuidv4().slice(0, 8)}`,
      projectId,
      baseName,
      { op: 'extend', route, ...shared, vocalGender: input.vocalGender ?? null },
      { taskId, sourceAssetId: sourceAsset?.id ?? null }
    )
    manifest.params.sourcePath = sourceAsset ? null : sourcePath
    manifest.trackId = trackId
    await saveJob(manifest)
    return finishDerivedJob(manifest, input, context)
  }
}

const replaceSectionOp: Operation<{
  sourceAssetId?: string
  sourcePath?: string
  startS: number
  endS: number
  prompt: string
  fullLyrics: string
  tags: string
  title: string
  negativeTags?: string
  model?: string
  projectId?: string
  trackId?: string
  background?: boolean
  fetchWav?: boolean
}> = {
  id: 'aurora_replace_section',
  annotations: { title: 'Replace audio section', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  outputSchema: outputSchema(jobSchema),
  description: "PAID Suno section replacement: sourceAssetId or sourcePath, prompt and section timing/control fields from the input schema. Provider ids choose the id route, otherwise audio uploads. Project follows source unless specified; trackId defaults to project root; background and fetchWav default false. WAV fetching adds credits. Returns job and replacement assets linked to source. Advance aurora_get_job_status, then inspect assets.",
  input: z.object({
    sourceAssetId: z.string().optional().describe('Project asset to edit'),
    sourcePath: z.string().optional().describe('OR an external audio file path'),
    startS: z.number().min(0).describe('Window start, seconds (2 decimals)'),
    endS: z.number().min(0).describe('Window end, seconds; at least 10 s after startS'),
    prompt: z.string().describe('Lyrics for the replaced window (instrumental sections: a short direction still goes here)'),
    fullLyrics: z.string().describe('The COMPLETE lyrics of the song after the edit'),
    tags: z.string().describe('Style tags for the new section (this endpoint names the field tags)'),
    title: z.string().max(100),
    negativeTags: z.string().optional().describe('Styles to exclude, ONE comma-separated string'),
    model: z.string().optional().describe(`${MODEL_DESCRIBE}. Upload route only — the id route reuses the source model`),
    projectId: z.string().optional(),
    trackId: landingTrackIdSchema,
    background: z.boolean().optional(),
    fetchWav: z.boolean().optional().describe('Blocking mode only: fetch the provider WAV per variation (default false)')
  }),
  async run(input, context) {
    if (input.endS - input.startS < 10) throw new Error('The window must be at least 10 seconds wide.')
    const { sourcePath, sourceAsset } = resolveSourcePath(input)
    const ids = sunoIdsOf(sourceAsset)
    const model = normalizeModel(input.model, DEFAULT_GEN_MODEL)
    const baseName = input.title.trim() || `${basename(sourcePath, extname(sourcePath))} edit`
    const projectId = await resolveDerivedProject(input.projectId, sourceAsset, baseName)
    const trackId = resolveLandingTrack(projectId, input.trackId)

    const common = {
      prompt: input.prompt,
      tags: input.tags,
      title: input.title,
      infillStartS: input.startS,
      infillEndS: input.endS,
      fullLyrics: input.fullLyrics,
      negativeTags: input.negativeTags
    }
    let taskId: string
    let route: 'ids' | 'upload'
    if (ids) {
      route = 'ids'
      assertNotAborted(context)
      taskId = await createReplaceSection({ ...common, ...ids })
    } else {
      route = 'upload'
      assertNotAborted(context)
      const uploadUrl = await uploadSourceAudio(sourcePath)
      assertNotAborted(context)
      taskId = await createReplaceSection({ ...common, uploadUrl, model })
    }

    const manifest = newJobManifest(
      'replace_section',
      `rep-${uuidv4().slice(0, 8)}`,
      projectId,
      baseName,
      { op: 'replace_section', route, ...common,
        model: route === 'upload' ? model : sourceAsset?.recipe.model ?? sourceAsset?.origin?.model,
        instrumental: false },
      { taskId, sourceAssetId: sourceAsset?.id ?? null }
    )
    manifest.params.sourcePath = sourceAsset ? null : sourcePath
    manifest.trackId = trackId
    await saveJob(manifest)
    return finishDerivedJob(manifest, input, context)
  }
}

const mashupOp: Operation<{
  sourceAssetIdA?: string
  sourcePathA?: string
  sourceAssetIdB?: string
  sourcePathB?: string
  prompt?: string
  customMode?: boolean
  style?: string
  title?: string
  instrumental?: boolean
  model?: string
  duration?: number
  vocalGender?: 'male' | 'female'
  styleWeight?: number
  weirdnessConstraint?: number
  audioWeight?: number
  projectId?: string
  trackId?: string
  background?: boolean
  fetchWav?: boolean
}> = {
  id: 'aurora_mashup',
  annotations: { title: 'Mash up two sources', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  outputSchema: outputSchema(jobSchema),
  description: "PAID Suno mashup: two source assets/paths and optional prompt/style/title/provider controls; both sources upload. Project follows source A unless specified; trackId defaults to project root. background and fetchWav default false; WAV fetching adds credits. Returns job and saved variations linked to source A. Advance aurora_get_job_status, then inspect assets; repeating spends again.",
  input: z.object({
    sourceAssetIdA: z.string().optional().describe('First source: project asset'),
    sourcePathA: z.string().optional().describe('OR first source: external file'),
    sourceAssetIdB: z.string().optional().describe('Second source: project asset'),
    sourcePathB: z.string().optional().describe('OR second source: external file'),
    prompt: z.string().optional().describe('Custom mode: exact lyrics. Non-custom: ≤500-char description'),
    customMode: z.boolean().optional().describe('Default: true when style or title is set'),
    style: z.string().optional().describe('≤1000 chars; custom mode needs BOTH style and title'),
    title: z.string().max(80).optional().describe('≤80 chars on this endpoint'),
    instrumental: z.boolean().optional(),
    model: z.string().optional().describe(MODEL_DESCRIBE),
    duration: durationSchema,
    vocalGender: z.enum(['male', 'female']).optional(),
    styleWeight: styleWeightSchema,
    weirdnessConstraint: weirdnessSchema,
    audioWeight: audioWeightSchema,
    projectId: z.string().optional(),
    trackId: landingTrackIdSchema,
    background: z.boolean().optional(),
    fetchWav: z.boolean().optional().describe('Blocking mode only: fetch the provider WAV per variation (default false)')
  }),
  async run(input, context) {
    const a = resolveSourcePath({ sourceAssetId: input.sourceAssetIdA, sourcePath: input.sourcePathA })
    const b = resolveSourcePath({ sourceAssetId: input.sourceAssetIdB, sourcePath: input.sourcePathB })
    const customMode = input.customMode ?? Boolean(input.style || input.title)
    if (customMode && (!input.style || !input.title)) {
      throw new Error('Custom mode needs BOTH a style and a title (you set only one).')
    }
    if (!customMode && (input.prompt?.length ?? 0) > 500) {
      throw new Error('Non-custom prompts cap at 500 chars.')
    }
    const model = normalizeModel(input.model, DEFAULT_GEN_MODEL)
    assertDurationUsable(input.duration, model, customMode)
    for (const src of [a, b]) {
      const d = await probeDurationSeconds(src.sourcePath)
      if (d !== null && d > MAX_COVER_REFERENCE_SECONDS) {
        throw new Error(`${basename(src.sourcePath)} is ${Math.round(d)}s — uploads cap at 8 minutes.`)
      }
    }
    const baseName = input.title?.trim() || `${basename(a.sourcePath, extname(a.sourcePath))} mashup`
    const projectId = await resolveDerivedProject(input.projectId, a.sourceAsset, baseName)
    const trackId = resolveLandingTrack(projectId, input.trackId)

    assertNotAborted(context)
    const urlA = await uploadSourceAudio(a.sourcePath)
    assertNotAborted(context)
    const urlB = await uploadSourceAudio(b.sourcePath)
    assertNotAborted(context)
    const taskId = await createMashup({
      uploadUrlList: [urlA, urlB],
      customMode,
      model,
      prompt: input.prompt,
      style: input.style,
      title: input.title,
      instrumental: input.instrumental,
      duration: input.duration,
      vocalGender: input.vocalGender,
      styleWeight: input.styleWeight,
      weirdnessConstraint: input.weirdnessConstraint,
      audioWeight: input.audioWeight
    })

    const manifest = newJobManifest(
      'mashup',
      `mup-${uuidv4().slice(0, 8)}`,
      projectId,
      baseName,
      {
        op: 'mashup',
        customMode,
        prompt: input.prompt,
        style: input.style,
        title: input.title,
        instrumental: input.instrumental ?? false,
        model,
        duration: input.duration,
        vocalGender: input.vocalGender ?? null,
        styleWeight: input.styleWeight,
        weirdnessConstraint: input.weirdnessConstraint,
        audioWeight: input.audioWeight,
        sourcePath: a.sourceAsset ? null : a.sourcePath,
        sourceAssetIdB: b.sourceAsset?.id ?? null,
        sourcePathB: b.sourceAsset ? null : b.sourcePath
      },
      { taskId, sourceAssetId: a.sourceAsset?.id ?? null }
    )
    manifest.trackId = trackId
    await saveJob(manifest)
    return finishDerivedJob(manifest, input, context)
  }
}

const splitOp: Operation<{ assetId: string; background?: boolean; estimateOnly?: boolean }> = {
  id: 'aurora_split',
  annotations: { title: 'Split seven stems', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  outputSchema: outputSchema(jobSchema.or(planSchema)),
  description: 'Split an asset into seven checked stems using three measured MVSEP routes plus local phase cancellation. PAID: uploads audio and spends MVSEP premium minutes; estimateOnly:true is free. background defaults true and queues durable work. Existing valid stems or an active split are reused without another submission. Returns a job with per-route attempts. Five stems come from MVSEP (vocals, kick, snare, toms, bass); two are built locally: hats = the DrumSep drums bus minus kick, snare and toms, and other (Other) = the track minus every stem pulled out in that split. Advance with aurora_get_job_status, then check with aurora_check_separation_result.',
  input: z.object({
    assetId: z.string().describe('Asset id from aurora_list_assets'),
    background: z.boolean().default(true).describe('true queues work; false waits up to 12 minutes with progress'),
    estimateOnly: z.boolean().default(false).describe('Free: exact three-route topology and duration-based provider units')
  }),
  async run(input, context) {
    if (input.estimateOnly) {
      const asset = getAsset(input.assetId)
      if (!asset) throw new Error(`Asset not found: ${input.assetId}`)
      const durationSeconds = await probeDurationSeconds(asset.path)
      return ok(separationPlan(Object.values(SPLIT_ROUTES).map((route) => route.id), durationSeconds),
        'Free split plan: three MVSEP calls plus local hats/Other calculation. Nothing submitted.')
    }
    const active = (await listJobs()).find((job) => job.kind === 'split' &&
      job.provider.assetId === input.assetId && isJobActive(job))
    if (active) return ok({ ...jobSummary(active), reused: true },
      `Active split job ${active.jobId} reused; no new paid job. Advance that job with aurora_get_job_status.`)
    const manifest = await startSplitJob(input.assetId)
    if (!isJobActive(manifest)) return ok({ ...jobSummary(manifest), reused: true }, jobText(manifest))
    if (input.background !== false) return ok(jobSummary(manifest), jobText(manifest))
    const finished = await awaitJob(manifest, context)
    return ok(jobSummary(finished), jobText(finished))
  }
}

const VOCAL_MODE_DESCRIBE =
  "lead_back = lead + backing vocals; male_female = male + female voices. Vocal stems come from the mode, never from the stems array"

const extractOp: Operation<{
  assetId: string
  stems?: string[]
  vocalMode?: 'lead_back' | 'male_female'
  includeReverb?: boolean
  estimateOnly?: boolean
  background?: boolean
}> = {
  id: 'aurora_extract',
  annotations: { title: 'Extract selected stems', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  outputSchema: outputSchema(jobSchema.or(planSchema)),
  description: "PAID MVSEP extraction of catalog groups, instruments and vocal modes from assetId, up to 12 minutes. stems defaults empty, vocalMode absent and includeReverb false; Other is free local phase cancellation. estimateOnly:true is free and returns exact route topology/options, quality/evidence and duration confidence. Otherwise uploads source audio and spends credits per planned call; bundles share calls, dereverb chains dry vocals. background defaults true and queues a durable plan; false advances with progress. Returns attempts, requested/delivered files, detectedKey and partial failures. Advance aurora_get_job_status, then aurora_check_separation_result.",
  input: z.object({
    assetId: z.string().describe('The asset to extract from (any kind)'),
    stems: z
      .array(z.enum(EXTRACT_SELECTION_IDS as [string, ...string[]]))
      .optional()
      .describe(`Non-vocal catalog stem ids: ${EXTRACT_SELECTION_IDS.join(', ')}. Vocal stems come from vocalMode/includeReverb; Other is free and automatic.`),
    vocalMode: z.enum(['lead_back', 'male_female']).optional().describe(VOCAL_MODE_DESCRIBE),
    includeReverb: z
      .boolean()
      .optional()
      .describe(
        'Dereverb the vocal first: adds a reverb-tail stem; with a vocalMode the bundle runs on the DRY ' +
          'vocal; alone it delivers dry vocal + reverb tail'
      ),
    estimateOnly: z
      .boolean()
      .optional()
      .describe('Return the call plan + cost estimate WITHOUT spending anything'),
    background: z.boolean().optional().describe('Strongly recommended — sequential calls take minutes each')
  }),
  async run(input, context) {
    const selection = {
      stems: input.stems ?? [],
      vocalSeparationType: input.vocalMode ?? null,
      includeReverb: input.includeReverb ?? false
    }

    const asset = getAsset(input.assetId)
    if (!asset) throw new Error(`Asset not found: ${input.assetId}`)
    const duration = await probeDurationSeconds(asset.path)
    const plan = planApiCalls(selection)
    const rawEstimate = duration === null ? null : estimateExtractCost(selection, duration)
    const estimate = rawEstimate ? { ...rawEstimate, purpose: 'Future Aurora metering; credits is not a current provider price.' } : null
    const routePlan = separationPlan(plan.calls.map((call) => call.routeId), duration, plan.calls)
    const plannedCalls = plan.calls.length

    if (input.estimateOnly) {
      return ok({ ...routePlan, estimate, stemsToDeliver: plan.stemsToDeliver },
        `Free plan: ${plannedCalls} MVSEP call(s). Duration ${duration === null ? 'unknown; price units cannot be estimated' : `${duration}s`}. Other is local. Nothing submitted.`)
    }
    assertNotAborted(context)

    const { asset: prepared, state } = await prepareExtract(input.assetId, selection)

    const manifest = newJobManifest(
      'extract',
      `ext-${uuidv4().slice(0, 8)}`,
      prepared.projectId,
      prepared.name,
      {
        assetId: input.assetId,
        stems: selection.stems,
        vocalMode: selection.vocalSeparationType,
        includeReverb: selection.includeReverb,
        plannedCalls
      },
      { assetId: input.assetId, extract: state }
    )
    manifest.stage = `queued plan: ${state.calls.length} MVSEP call(s); no submission yet`
    await saveJob(manifest)

    if (input.background !== false) {
      const summary = jobSummary(manifest)
      ;(summary as Record<string, unknown>).estimate = estimate
      summary.plan = routePlan
      return ok(summary, `${jobText(manifest)} Plan: ${plannedCalls} MVSEP call(s).`)
    }
    const finished = await awaitJob(manifest, context)
    const summary = jobSummary(finished)
    ;(summary as Record<string, unknown>).estimate = estimate
    summary.plan = routePlan
    if ((finished.status === 'done' || finished.status === 'completed') && finished.provider.extract?.detectedKey) {
      ;(summary as Record<string, unknown>).detectedKey = finished.provider.extract.detectedKey
    }
    return ok(summary, jobText(finished))
  }
}

const getJobStatusOp: Operation<{ jobId: string; waitSeconds?: number; advance?: boolean }> = {
  id: 'aurora_get_job_status',
  annotations: { title: 'Advance or read job', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  outputSchema: outputSchema(jobSchema),
  description: 'Read or advance any durable generation, split or extraction job. Default advance:true may upload the next extraction/split call, spend credits, download checked outputs and write library files. waitSeconds defaults 0 (one advancement), maximum 30 (bounds waiting between engine units; an in-flight interaction settles); advance:false gives a free local snapshot. Returns states, attempts, partial failures, outputs and expiring Suno preview URLs. Call again to resume, or aurora_cancel_job to stop future units.',
  input: z.object({
    jobId: z.string(),
    waitSeconds: z.number().min(0).max(30).default(0),
    advance: z.boolean().default(true).describe('false reads the manifest only; true may spend credits and land files')
  }),
  async run(input, context) {
    const manifest = await loadJob(input.jobId)
    if (!manifest) throw new Error(`Job not found: ${input.jobId}. Use aurora_list_jobs.`)
    if (input.advance === false || !isJobActive(manifest)) return ok(jobSummary(manifest), jobText(manifest))
    const advanced = input.waitSeconds ? await awaitJob(manifest, context, input.waitSeconds * 1000) :
      await advanceJob(manifest, context?.signal)
    await context?.onProgress?.({ progress: Object.values(advanced.landed).filter(Boolean).length,
      message: `${advanced.status}: ${advanced.stage}` })
    return ok(jobSummary(advanced), jobText(advanced))
  }
}

const listJobsOp: Operation<Record<string, never>> = {
  id: 'aurora_list_jobs',
  annotations: { title: 'Local job snapshots', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ jobs: z.array(jobSchema) })),
  description: "Free local snapshots, no inputs: returns durable jobs with states, outputs, per-route attempts and failures. Never advances, uploads or spends. Use aurora_get_job_status advance:false for a single snapshot, advance:true to resume paid work, or aurora_cancel_job to stop future units.",
  input: z.object({}).strict(),
  async run() {
    const jobs = await listJobs()
    return ok({ jobs: jobs.map(jobSummary) })
  }
}

// ── Audio utilities (local ffmpeg — free) ───────────────────────

const pitchShiftOp: Operation<{
  assetId?: string
  path?: string
  semitones: number
  preserveTempo?: boolean
  format?: 'wav' | 'mp3'
}> = {
  id: 'aurora_pitch_shift',
  annotations: { title: 'Pitch shift locally', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  outputSchema: outputSchema(z.object({ outputPath: z.string(), engine: z.string(), asset: assetSchema.nullable() })),
  description: "Free local audio processing: assetId or absolute path and required semitones. preserveTempo defaults false (varispeed); format defaults wav, optional mp3. Writes a sibling output and registers a new asset when input is an asset. Returns outputPath, engine and nullable asset. Repeating can overwrite output and add another row; list assets or import into the DAW next.",
  input: z.object({
    assetId: z.string().optional(),
    path: z.string().optional().describe('OR an absolute file path'),
    semitones: z.number().describe('e.g. 3, -2, 0.5'),
    preserveTempo: z.boolean().optional(),
    format: z.enum(['wav', 'mp3']).optional().describe('Output format (default wav)')
  }),
  async run(input, context) {
    const { path, asset } = resolveAudioInput(input)
    const format = input.format ?? 'wav'
    const stem = basename(path, extname(path))
    const sign = input.semitones >= 0 ? '+' : ''
    const outPath = join(dirname(path), `${stem}${sign}${input.semitones}st.${format}`)

    const engine = await pitchShift(path, outPath, input.semitones, input.preserveTempo ?? false, format)

    let newAsset: ProjectAsset | null = null
    if (asset) {
      newAsset = insertAsset({
        projectId: asset.projectId,
        kind: 'track',
        name: basename(outPath, extname(outPath)),
        path: outPath,
        origin: { tool: 'pitch_shift', semitones: input.semitones, engine, sourceAssetId: asset.id },
        sourceAssetId: asset.id,
        recipe: localRecipe({ operation: 'pitch-shift', recordedBy: 'mcp', fromAssetId: asset.id,
          settings: { semitones: input.semitones, preserveTempo: input.preserveTempo ?? false, format, engine } })
      })
    }
    return ok({ outputPath: outPath, engine, asset: newAsset })
  }
}

const convertOp: Operation<{ assetId?: string; path?: string; to: 'wav' | 'mp3' }> = {
  id: 'aurora_convert',
  annotations: { title: 'Convert local audio', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  outputSchema: outputSchema(z.object({ outputPath: z.string(), asset: assetSchema.nullable() })),
  description: "Free local ffmpeg conversion: assetId or absolute path and required to (wav or mp3). WAV is 44.1 kHz stereo float32; MP3 is 320k CBR. Writes a sibling file and creates an asset for asset inputs. Returns outputPath and nullable asset. Repeating may overwrite and duplicate library rows. List assets or use the output path in the DAW.",
  input: z.object({
    assetId: z.string().optional(),
    path: z.string().optional(),
    to: z.enum(['wav', 'mp3'])
  }),
  async run(input, context) {
    const { path, asset } = resolveAudioInput(input)
    const stem = basename(path, extname(path))
    const sameExt = extname(path).toLowerCase() === `.${input.to}`
    const outPath = join(dirname(path), `${stem}${sameExt ? '-converted' : ''}.${input.to}`)

    if (input.to === 'wav') await standardizeToWav(path, outPath)
    else await convertToMp3(path, outPath)

    let newAsset: ProjectAsset | null = null
    if (asset) {
      newAsset = insertAsset({
        projectId: asset.projectId,
        kind: 'track',
        name: basename(outPath, extname(outPath)),
        path: outPath,
        origin: { tool: 'convert', to: input.to, sourceAssetId: asset.id },
        sourceAssetId: asset.id,
        recipe: localRecipe({ operation: 'convert', recordedBy: 'mcp', fromAssetId: asset.id, settings: { to: input.to } })
      })
    }
    return ok({ outputPath: outPath, asset: newAsset })
  }
}

// ── Sidecars (local Python — free, require the aurora repo) ─────

const rvcUpscaleOp: Operation<{
  assetId?: string
  path?: string
  stemType?: string
  model?: string
  f0UpKey?: number
}> = {
  id: 'aurora_rvc_upscale',
  annotations: { title: 'Upscale vocals locally', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ outputPath: z.string() })),
  description: "Free local RVC Python sidecar: supply WAV path or assetId plus stemType (default vocals), model defaults jb and f0UpKey defaults 0. Requires AURORA_REPO and installed sidecar dependencies. Writes/overwrites sibling _upscaled.wav; returns outputPath. No provider upload or credits. Import output with aurora_import_file if wanted in the library.",
  input: z.object({
    assetId: z.string().optional().describe('Asset whose vocals stem to upscale'),
    stemType: stemIdSchema.optional().describe('Stem to pick from the asset (default "vocals"). Use other for Other; ee is a deprecated alias.'),
    path: z.string().optional().describe('OR a direct WAV path'),
    model: z.string().optional().describe("'jb' (default) or 'purposeaudacity'"),
    f0UpKey: z.number().optional().describe('Pitch shift in semitones (default 0)')
  }),
  async run(input, context) {
    let inputPath = input.path
    if (input.assetId) {
      const stems = getStems(input.assetId)
      const want = input.stemType ?? 'vocals'
      const stem = stems.find((s) => s.stemType === want)
      if (!stem) {
        throw new Error(
          `Asset ${input.assetId} has no "${want}" stem. Split it first (aurora_split) or pass a direct path.`
        )
      }
      inputPath = stem.path
    }
    if (!inputPath) throw new Error('Provide assetId (+stemType) or path.')

    const outPath = join(dirname(inputPath), `${basename(inputPath, extname(inputPath))}_upscaled.wav`)
    await runRvcUpscale({ inputPath, outputPath: outPath, model: input.model, f0UpKey: input.f0UpKey })
    return ok({ outputPath: outPath })
  }
}

const ripMidiOp: Operation<{
  assetId?: string
  stemType?: string
  path?: string
  mode?: 'poly' | 'mono' | 'auto'
  instrument?: string
}> = {
  id: 'aurora_rip_midi',
  annotations: { title: 'Transcribe MIDI locally', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ outputPath: z.string() })),
  description: "Free local MIDI transcription: WAV path or assetId plus required stemType; mode defaults auto, optional instrument hints routing (drums onset, mono CREPE, poly Basic Pitch). Requires AURORA_REPO and sidecar dependencies. Writes/overwrites sibling .mid and returns outputPath. No upload or credits. Open the MIDI in the DAW.",
  input: z.object({
    assetId: z.string().optional(),
    stemType: stemIdSchema.optional().describe('Which stem of the asset (e.g. "bass", "kick", "other"). ee is a deprecated alias for other.'),
    path: z.string().optional(),
    mode: z.enum(['poly', 'mono', 'auto']).optional().describe('Transcription path (default auto)'),
    instrument: z.string().optional().describe('Instrument hint for auto-routing, e.g. "bass", "kick"')
  }),
  async run(input, context) {
    let inputPath = input.path
    let instrument = input.instrument
    if (input.assetId) {
      const stems = getStems(input.assetId)
      if (!input.stemType) throw new Error('Pass stemType with assetId (e.g. "bass", "kick").')
      const stem = stems.find((s) => s.stemType === input.stemType)
      if (!stem) throw new Error(`Asset ${input.assetId} has no "${input.stemType}" stem.`)
      inputPath = stem.path
      instrument ??= input.stemType
    }
    if (!inputPath) throw new Error('Provide assetId+stemType or path.')

    const outPath = join(dirname(inputPath), `${basename(inputPath, extname(inputPath))}.mid`)
    await runRipMidi({ inputPath, outputPath: outPath, mode: input.mode ?? 'auto', instrument })
    return ok({ outputPath: outPath })
  }
}

// ── Skills delivery (MCP-only clients) ──────────────────────────

const listSeparationRoutesOp: Operation<{ surface?: string; group?: string }> = {
  id: 'aurora_list_separation_routes',
  annotations: { title: 'Measured separation routes', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.object({ routes: z.array(routeSchema) })),
  description: 'Free, local route discovery: returns every measured route with MVSEP algorithm, exact options/output keys, checks, quality, evidence and surface. Optional surface selects split or an extract category; group matches a route id, stem id or stem prefix. Nothing uploads or spends credits. Use aurora_split estimateOnly:true or aurora_extract estimateOnly:true to plan, then explicitly run the paid tool.',
  input: z.object({
    surface: z.enum(['split', 'extract group', 'extract instrument', 'extract bundle']).optional(),
    group: stemIdSchema.optional().describe('Route id, delivered stem id or stem prefix (for example drum or guitar). ee is a deprecated alias for other.')
  }),
  async run(input) {
    const routes = listSeparationRoutes().filter((route) => (!input.surface || route.surface === input.surface) &&
      (!input.group || route.id === input.group || Object.keys(route.delivers).some((stem) =>
        stem === input.group || stem.startsWith(`${input.group}_`))))
      .map((route) => ({ ...route, sep_type: String(route.sepType),
        outputKeys: planSeparationRoute(route.id).outputKeys, checks: { family: route.family, sums: route.sums } }))
    return ok({ routes }, `${routes.length} separation routes. Plan before spending; check results after landing.`)
  }
}

const checkSeparationResultOp: Operation<{
  jobId?: string; routeId?: string; inputPath?: string; outputs?: Record<string, string>
}> = {
  id: 'aurora_check_separation_result',
  annotations: { title: 'Local separation checks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(checkSchema),
  description: 'Free, local audio verification. Supply either jobId for saved separation provenance/replay, or routeId + inputPath + outputs keyed by exact MVSEP output key (including auxiliary sum outputs). Returns ok, problems, notes, metrics, checked window and limitations. Metrics are in dB: a sum metric is how far the parts miss their whole (-20 or lower passes; -200 means digital silence, an exact sum), level metrics are relative to the input. No upload or provider spending. Job checks report recorded passes when discarded auxiliary files prevent replay; names and sums cannot detect clean swaps for brass/strings/keys/guitar. Inspect problems before authorizing replacement paid work.',
  input: z.object({
    jobId: z.string().optional(), routeId: z.string().optional(), inputPath: z.string().optional(),
    outputs: z.record(z.string()).optional().describe('Exact outputKey → local WAV path; include every checking output')
  }).superRefine((input, ctx) => {
    const local = input.routeId !== undefined || input.inputPath !== undefined || input.outputs !== undefined
    if (input.jobId ? local : !input.routeId || !input.inputPath || !input.outputs)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Supply either jobId alone or routeId, inputPath and outputs together.' })
  }),
  async run(input) {
    if (!input.jobId) {
      if (!listSeparationRoutes().some((route) => route.id === input.routeId)) throw new Error(`Unknown routeId: ${input.routeId}. Use aurora_list_separation_routes.`)
      return ok(await checkSeparationOutputs({ routeId: input.routeId!, inputPath: input.inputPath!, outputs: input.outputs! }),
        'Local audio checks finished; inspect ok, problems and limitations.')
    }
    const job = await loadJob(input.jobId)
    if (!job) throw new Error(`Job not found: ${input.jobId}`)
    const attempts: SeparationAttempt[] = [...Object.values(job.provider.splitAttempts ?? {}).filter((a): a is SeparationAttempt => Boolean(a)),
      ...(job.provider.extract?.callResults ?? [])]
    if (!attempts.length) throw new Error('Provide a split/extract job with recorded separation attempts, or local route outputs.')
    const checks = await Promise.all(attempts.map(async (attempt) => {
      const recorded = attempt.checks
      if (!recorded) return { routeId: attempt.routeId, ok: false, problems: [attempt.error?.message ?? `No saved check for ${attempt.status} attempt`],
        notes: [], metrics: {}, checkWindowSeconds: 0, limitations: ['No completed check is recorded.'] }
      const missingFiles = recorded.outputs.filter((output) => output.path && !existsSync(output.path))
      if (missingFiles.length) return { ...recorded, routeId: attempt.routeId, ok: false,
        problems: missingFiles.map((output) => `Recorded output is missing: ${output.key}`),
        limitations: [...recorded.limitations, 'Recorded landing checks do not certify files that have since disappeared.'] }
      if (recorded.unavailableReplayKeys.length || !attempt.inputPath) return { ...recorded,
        routeId: attempt.routeId, verification: 'recorded', ok: true, problems: [],
        notes: [...recorded.notes, 'Reporting the recorded landing check, not a new replay.'],
        limitations: [...recorded.limitations, 'Current files cannot be fully rechecked without all auxiliary outputs and the recorded input.'] }
      const outputs = Object.fromEntries(recorded.outputs.filter((out) => out.path).map((out) => [out.key, out.path!]))
      return { ...await checkSeparationOutputs({ routeId: attempt.routeId, inputPath: attempt.inputPath, outputs }),
        routeId: attempt.routeId, verification: 'replayed' }
    }))
    return ok({ jobId: job.jobId, ok: checks.every((check) => check.ok),
      problems: checks.flatMap((check) => check.problems.map((problem) => `${check.routeId}: ${problem}`)),
      notes: checks.flatMap((check) => check.notes),
      metrics: Object.fromEntries(checks.flatMap((check) => Object.entries(check.metrics).map(([key, value]) => [`${check.routeId}.${key}`, value]))),
      checkWindowSeconds: Math.min(...checks.map((check) => check.checkWindowSeconds)),
      limitations: [...new Set(checks.flatMap((check) => check.limitations))], checks },
    `Checked provenance/local outputs for job ${job.jobId}; inspect problems and replay limitations.`)
  }
}

const cancelJobOp: Operation<{ jobId: string }> = {
  id: 'aurora_cancel_job',
  annotations: { title: 'Cancel future job units', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(jobSchema),
  description: 'Stop future submission, polling and landing units of a durable job. Input jobId; returns its manifest summary. Free local cancellation intent; already accepted provider work may still run and is not refunded. An interaction in progress settles, and saved outputs stay. Read aurora_get_job_status with advance:false to inspect the final state.',
  input: z.object({ jobId: z.string() }),
  async run(input) { const job = await cancelJob(input.jobId); return ok(jobSummary(job), jobText(job)) }
}

const getPromptingGuideOp: Operation<{ topic?: string }> = {
  id: 'aurora_get_prompting_guide',
  annotations: { title: 'Bundled Aurora guides', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outputSchema: outputSchema(z.union([z.object({ guides: z.array(z.object({ name: z.string(), description: z.string() })) }), z.object({ name: z.string(), content: z.string() })])),
  description: "Free offline bundled guides: omit topic to list names and descriptions; use exact name or an unambiguous keyword to retrieve content. Ambiguous names return guidance to choose. Covers workflow, cost discipline, Suno prompting and measured separation routes. Nothing uploads/spends. Plan with route discovery and estimateOnly before invoking paid tools.",
  input: z.object({
    topic: z.string().optional().describe('Guide name (from the no-topic listing) or a keyword')
  }),
  async run(input, context) {
    const names = Object.keys(SKILLS)
    if (!input.topic) {
      const guides = names.map((name) => ({ name, description: /^description:\s*(.+)$/m.exec(SKILLS[name])?.[1]?.trim() ?? name }))
      return ok({ guides }, `Available guides: ${names.join(', ')}. Retrieve with topic:<exact name>.`)
    }
    const exact = Object.hasOwn(SKILLS, input.topic) ? SKILLS[input.topic] : undefined
    if (exact) return ok({ name: input.topic, content: exact }, `Retrieved guide ${input.topic}.`)
    const matches = names.filter((name) => name.includes(input.topic!.toLowerCase()))
    if (matches.length === 1) return ok({ name: matches[0], content: SKILLS[matches[0]] }, `Retrieved guide ${matches[0]}.`)
    if (matches.length > 1) throw new Error(`Unknown exact guide: ambiguous topic "${input.topic}". Choose ${matches.join(', ')}.`)
    throw new Error(`No guide matching "${input.topic}". Available: ${names.join(', ')}`)
  }
}

// ── Registry ────────────────────────────────────────────────────

const operationDefinitions = [
  getViewOp,
  setViewOp,
  getCredits,
  getWorkspaceState,
  createProjectOp,
  listProjectsOp,
  renameProjectOp,
  deleteProjectOp,
  listAssetsOp,
  createTrackOp,
  listTracksOp,
  renameTrackOp,
  deleteTrackOp,
  setAssetTrackOp,
  favoriteAssetOp,
  importFileOp,
  addReferenceOp,
  deleteAssetOp,
  getRecipeOp,
  copyRecipeOp,
  reusePromptOp,
  reuseReferenceOp,
  makeVariationsOp,
  getStemViewOp,
  getStemPeaksOp,
  measureStemsOp,
  exportStemsOp,
  importSplitJobOp,
  createStemSetOp,
  deleteStemSetOp,
  fetchWavOp,
  generateOp,
  soundsOp,
  coverOp,
  addVocalsOp,
  addInstrumentalOp,
  extendOp,
  replaceSectionOp,
  mashupOp,
  splitOp,
  extractOp,
  listSeparationRoutesOp,
  checkSeparationResultOp,
  cancelJobOp,
  getJobStatusOp,
  listJobsOp,
  pitchShiftOp,
  convertOp,
  rvcUpscaleOp,
  ripMidiOp,
  getPromptingGuideOp
] as unknown as ReadonlyArray<Operation<unknown>>

export const ALL_OPERATIONS: ReadonlyArray<Operation<unknown>> = operationDefinitions.map((op) => ({
  ...op,
  async run(input, context) {
    let result: OperationResult | undefined
    try {
      assertNotAborted(context)
      const args = op.input.parse(input)
      let latest: OperationProgress = { progress: 0, message: `${op.annotations.title}: starting` }
      const report = async (update: OperationProgress): Promise<void> => {
        latest = { ...update, progress: Math.max(latest.progress, update.progress) }
        if (!context?.signal?.aborted) await context?.onProgress?.(latest)
      }
      const reportsProgress = !op.annotations.readOnlyHint && op.annotations.openWorldHint
      const heartbeat = reportsProgress && context?.onProgress ? setInterval(() => {
        void report(latest).catch(() => {})
      }, 5000) : undefined
      try {
        if (reportsProgress) await report(latest)
        result = await op.run(args, { ...context, onProgress: report })
      } finally { if (heartbeat) clearInterval(heartbeat) }
      const data = result.structuredContent
      if (typeof data.jobId === 'string' && ['failed', 'error', 'partial'].includes(String(data.status))) {
        const detail = (data.lastError as JobError | undefined) ?? {
          code: 'JOB_PARTIAL', message: 'Some planned outputs could not be delivered.', retryable: false,
          nextAction: 'Inspect callResults, saved outputs and limitations before authorizing replacement paid work.'
        }
        result = { ...result, isError: true, data: { ...data, error: { ...detail, jobId: data.jobId } },
          structuredContent: { ...data, error: { ...detail, jobId: data.jobId } } }
      }
      if (context?.signal?.aborted) {
        const failure = operationFailure(Object.assign(new Error('Request cancelled; no subsequent units were started.'), {
          code: 'REQUEST_CANCELLED', retryable: false, nextAction: 'Read the durable job snapshot; accepted provider work may still run. Use aurora_cancel_job to stop future units.'
        }), typeof data.jobId === 'string' ? data.jobId : undefined)
        result = { ...failure, data: { ...data, ...failure.data }, structuredContent: { ...data, ...failure.structuredContent } }
      }
      const validation = op.outputSchema.safeParse(JSON.parse(JSON.stringify(result.structuredContent)))
      if (!validation.success) throw Object.assign(new Error(`Invalid operation output: ${validation.error.issues.map((issue) =>
        `${issue.path.join('.')}: ${issue.message}`).join('; ')}`), {
        code: 'OUTPUT_CONTRACT', retryable: false,
        nextAction: 'Report this server contract mismatch. Inspect any existing job before repeating paid work.'
      })
      return result
    } catch (error) {
      const jobId = result?.structuredContent.jobId ??
        (input && typeof input === 'object' && 'jobId' in input ? input.jobId : undefined)
      return operationFailure(error, typeof jobId === 'string' ? jobId : undefined)
    }
  }
}))
