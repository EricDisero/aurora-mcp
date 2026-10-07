// Background-job model. Long ops (generate / sounds / cover / split) can submit
// and return immediately; the job's provider handles (taskId / MVSEP hashes)
// persist to userData/agent-jobs/<jobId>.json, so status survives process
// restarts — aurora_get_job_status re-polls the PROVIDER, not in-process state,
// and finishes downloads/DB-landing the moment results are ready (per-stem
// progressive for splits). Mirrors the bridge's job.json manifest discipline.

import { join, extname } from 'node:path'
import { mkdir, readFile, readdir, open, rename, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { getJobsDir } from './paths.js'
import {
  downloadTo,
  fetchGenerationRecord,
  generationFailureDetail,
  isGenerationFailure
} from './providers/suno.js'
import { fetchSeparationStatus, resolveSeparationStatus, mvsepProvider, MvsepError, separationError } from './providers/mvsep.js'
import { ensureKindDir, getAsset, insertAsset, uniqueDestPath } from './storage/assets.js'
import { landSplitJob, finalizeSplit, prepareSplit, type SplitJobName } from './split.js'
import { SPLIT_ROUTES } from './separation/routes.js'
import { submitRoute } from './separation/run-route.js'
import { describeSeparationResult } from './separation-tools.js'
import { getStems } from './storage/stems.js'
import {
  failExtractCall,
  finalizeExtract,
  landExtractCall,
  submitNextExtractCall,
  type ExtractJobState
} from './extract.js'
import { STEM_TYPES, normalizeStemId, type JobError, type SeparationAttempt } from './types.js'
import { generationRecipe, type RecipeOperation } from './recipe.js'

const JOB_STATUSES = ['queued', 'submitting', 'waiting', 'landing', 'completed', 'partial', 'failed', 'cancelled'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

const JOB_KINDS = ['generate', 'sounds', 'cover', 'add_vocals', 'add_instrumental', 'extend', 'replace_section', 'mashup', 'split', 'extract'] as const
export type JobKind = (typeof JOB_KINDS)[number]

export interface JobManifest {
  version?: 1
  jobId: string
  kind: JobKind
  /** Legacy values are accepted on read; new writes use JobStatus. */
  status: JobStatus | 'running' | 'done' | 'error'
  error?: string
  lastError?: JobError
  cancelRequestedAt?: string
  pollIntervalMs?: number
  duplicateOf?: string
  createdAt: string
  updatedAt: string
  projectId: string
  /** Track (project subfolder) the landed assets file into; null/absent = project root. */
  trackId?: string | null
  /** Display-name base for landed assets. */
  baseName: string
  /** Original op params, for traceability. */
  params: Record<string, unknown>
  provider: {
    /** generate / sounds / cover */
    taskId?: string
    sourceAssetId?: string | null
    /** split */
    assetId?: string
    stemsDir?: string
    hashes?: Partial<Record<SplitJobName, string>>
    splitAttempts?: Partial<Record<SplitJobName, SeparationAttempt>>
    lastSubmittedAt?: string
    /** extract — the sequential call-plan state machine (extract.ts). */
    extract?: ExtractJobState
  }
  /** Per-sub-unit idempotency flags (split job names / 'assets'). */
  landed: Record<string, boolean>
  /** DB ids of landed assets. */
  assetIds: string[]
  /** Landed stems (type + path). */
  stems: Array<{ stemType: string; path: string }>
  lastStatus?: string
  /** Listenable mid-generation preview URLs (expire server-side — never persist
   *  as asset paths; they're a head start, not the product). */
  streamUrls?: string[]
  stage: string
}

function jobPath(jobId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(jobId)) {
    throw new MvsepError('JOB_ID_INVALID', 'Invalid job id.', false, 'Use an id returned by listJobs.', 'manifest')
  }
  return join(getJobsDir(), `${jobId}.json`)
}

/** Old manifests name the leftover stem 'ee': read it as 'other'. Paths and provider handles are untouched. */
function normalizeJobStemIds(m: JobManifest): void {
  const rekey = <T>(value: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(value).map(([id, data]) => [normalizeStemId(id), data]))
  m.landed = rekey(m.landed)
  for (const stem of m.stems) stem.stemType = normalizeStemId(stem.stemType)
  const state = m.provider.extract
  if (state) {
    state.extractedFiles = rekey(state.extractedFiles)
    state.requestedStemIds = state.requestedStemIds?.map(normalizeStemId)
  }
  for (const attempt of [...Object.values(m.provider.splitAttempts ?? {}), ...(state?.callResults ?? [])]) {
    if (attempt) attempt.deliveredStemIds = attempt.deliveredStemIds.map(normalizeStemId)
  }
}

export async function saveJob(m: JobManifest): Promise<void> {
  const path = jobPath(m.jobId)
  m.version = 1
  await mkdir(getJobsDir(), { recursive: true })
  await applyCancellation(m)
  m.updatedAt = new Date().toISOString()
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(tmp, 'wx')
    try { await file.writeFile(JSON.stringify(m, null, 2)); await file.sync() }
    finally { await file.close() }
    await rename(tmp, path)
  }
  finally { await unlink(tmp).catch(() => {}) }
}

export async function loadJob(jobId: string): Promise<JobManifest | null> {
  const p = jobPath(jobId)
  try {
    const m = JSON.parse(await readFile(p, 'utf-8')) as JobManifest
    if (!m || m.jobId !== jobId || (m.version !== undefined && m.version !== 1) ||
      !m.provider || typeof m.provider !== 'object' || !m.landed || typeof m.landed !== 'object' ||
      typeof m.createdAt !== 'string' || typeof m.updatedAt !== 'string' || typeof m.projectId !== 'string' ||
      !JOB_KINDS.includes(m.kind) || !Number.isFinite(Date.parse(m.createdAt)) || !Number.isFinite(Date.parse(m.updatedAt)) ||
      !Array.isArray(m.stems) || !Array.isArray(m.assetIds) ||
      ![...JOB_STATUSES, 'running', 'done', 'error'].includes(m.status)) {
      throw new Error('Unsupported or invalid manifest')
    }
    const state = m.provider.extract
    if (state && (!Array.isArray(state.calls) || !Number.isInteger(state.callIndex) || state.callIndex < 0 ||
      state.callIndex > state.calls.length || (state.currentHash !== null && typeof state.currentHash !== 'string') ||
      !state.extractedFiles || !Array.isArray(state.failures))) throw new Error('Invalid extraction state')
    // Older manifests planned by the independent catalog have ids but no routeId.
    if (state) for (const call of state.calls) call.routeId ??= call.id
    normalizeJobStemIds(m)
    await applyCancellation(m)
    return m
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new MvsepError('JOB_MANIFEST_CORRUPT', `Job ${jobId} has an unreadable or unsupported manifest.`, false,
      'Restore or inspect the manifest. Do not recreate paid work whose hashes may be in it.', 'manifest')
  }
}

export async function listJobs(): Promise<JobManifest[]> {
  const dir = getJobsDir()
  if (!existsSync(dir)) return []
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  const jobs: JobManifest[] = []
  for (const f of files) {
    const job = await loadJob(f.slice(0, -5))
    if (job) jobs.push(job)
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function newJobManifest(
  kind: JobKind,
  jobId: string,
  projectId: string,
  baseName: string,
  params: Record<string, unknown>,
  provider: JobManifest['provider']
): JobManifest {
  const now = new Date().toISOString()
  if (kind === 'split') {
    provider.splitAttempts ??= Object.fromEntries((Object.keys(SPLIT_ROUTES) as SplitJobName[]).map((name) => [name, {
      routeId: SPLIT_ROUTES[name].id, status: provider.hashes?.[name] ? 'accepted' : 'pending',
      hash: provider.hashes?.[name], deliveredStemIds: []
    }]))
  }
  return {
    version: 1,
    jobId,
    kind,
    status: provider.taskId || provider.hashes ? 'waiting' : 'queued',
    pollIntervalMs: 5000,
    createdAt: now,
    updatedAt: now,
    projectId,
    baseName,
    params,
    provider,
    landed: {},
    assetIds: [],
    stems: [],
    stage: provider.taskId || provider.hashes ? 'submitted' : 'planned'
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'track'
}

/** Land finished generation/sounds/cover variations as project assets —
 *  mirrors the app's generation:generate landing (MP3 + audioId in origin;
 *  the app's or MCP's fetch-WAV upgrades on demand). */
async function landGenerationAssets(
  m: JobManifest,
  variations: Array<{ id?: string; audioUrl?: string }>,
  signal?: AbortSignal
): Promise<void> {
  // Source-derived transforms land as 'cover' kind (linked to the source);
  // from-nothing generations as 'generation'. add_vocals/add_instrumental/
  // sounds keep their historical 'generation' landing.
  const derived = m.kind === 'cover' || m.kind === 'extend' || m.kind === 'replace_section' || m.kind === 'mashup'
  const kind = derived && m.provider.sourceAssetId ? 'cover' : 'generation'
  const outputDir = await ensureKindDir(m.projectId, kind, m.trackId)
  const operations: Record<JobKind, RecipeOperation> = {
    generate: 'generate', sounds: 'sounds', cover: 'cover', add_vocals: 'add-vocals',
    add_instrumental: 'add-instrumental', extend: 'extend', replace_section: 'replace-section',
    mashup: 'mashup', split: 'split', extract: 'extract'
  }
  const operation = operations[m.kind]
  const recipe = generationRecipe({ operation, params: m.params, recordedBy: 'mcp',
    sourceAssetId: m.provider.sourceAssetId ?? null,
    sourcePath: typeof m.params.sourcePath === 'string' ? m.params.sourcePath : null,
    sourceAssetIdB: typeof m.params.sourceAssetIdB === 'string' ? m.params.sourceAssetIdB : null,
    sourcePathB: typeof m.params.sourcePathB === 'string' ? m.params.sourcePathB : null })

  for (let i = 0; i < variations.length; i++) {
    if (await stopped(m, signal)) return
    if (m.landed[`variation-${i}`]) continue
    const v = variations[i]
    if (!v.audioUrl) continue
    const variantName = variations.length > 1 ? `${m.baseName} v${i + 1}` : m.baseName
    const ext = extname(new URL(v.audioUrl).pathname) || '.mp3'
    const dest = uniqueDestPath(outputDir, `${sanitizeFileName(variantName)}${ext}`)
    await downloadTo(v.audioUrl, dest)

    const asset = insertAsset({
      projectId: m.projectId,
      trackId: m.trackId ?? null,
      kind,
      name: sanitizeFileName(variantName),
      path: dest,
      origin: {
        provider: 'sunoapi',
        ...m.params,
        operation,
        taskId: m.provider.taskId,
        audioId: v.id ?? null
      },
      sourceAssetId: m.provider.sourceAssetId ?? null,
      recipe
    })
    m.assetIds.push(asset.id)
    m.landed[`variation-${i}`] = true
    await saveJob(m)
  }
}

export function isJobActive(m: JobManifest): boolean {
  return ['queued', 'submitting', 'waiting', 'landing', 'running'].includes(m.status)
}

async function applyCancellation(m: JobManifest): Promise<void> {
  try {
    const requestedAt = await readFile(`${jobPath(m.jobId)}.cancel`, 'utf8')
    // A cancellation requested after the terminal save does not change a settled outcome.
    if (!isJobActive(m) && !m.cancelRequestedAt && Date.parse(m.updatedAt) >= Date.parse(requestedAt)) return
    m.cancelRequestedAt = requestedAt
    m.status = 'cancelled'
    m.stage = 'Cancelled: no further submissions or landing units. Already-landed outputs stay; submitted MVSEP work may still run.'
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

async function stopped(m: JobManifest, signal?: AbortSignal): Promise<boolean> {
  await applyCancellation(m)
  return m.status === 'cancelled' || signal?.aborted === true
}

/** Exclusive across CLI/MCP processes. A live owner is never displaced by an elapsed timer. */
async function acquireLease(key: string): Promise<(() => Promise<void>) | null> {
  await mkdir(getJobsDir(), { recursive: true })
  const path = `${jobPath(key)}.lock`
  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx')
      try { await file.writeFile(JSON.stringify({ pid: process.pid, token })) }
      finally { await file.close() }
      return async () => {
        const owner = JSON.parse(await readFile(path, 'utf8')) as { token: string }
        if (owner.token === token) await unlink(path)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const owner = JSON.parse(await readFile(path, 'utf8')) as { pid: number }
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) return null
        try { process.kill(owner.pid, 0); return null }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') return null }
        await unlink(path)
      } catch { return null }
    }
  }
  return null
}

function sourceLeaseKey(kind: string, assetId: string): string {
  return `source-${kind}-${createHash('sha256').update(assetId).digest('hex')}`
}

/** Queue a split without spending; reuse active work or seven valid distinct WAV stems. */
export async function startSplitJob(assetId: string): Promise<JobManifest> {
  const release = await acquireLease(sourceLeaseKey('split', assetId))
  if (!release) throw new MvsepError('JOB_BUSY', 'Another process is preparing this split.', true,
    'List jobs and reuse the existing split; retry after preparation finishes.', 'queued')
  try {
    const active = (await listJobs()).find((job) => job.kind === 'split' && job.provider.assetId === assetId && isJobActive(job))
    if (active) return active
    const asset = getAsset(assetId)
    if (!asset) throw new Error(`Asset not found: ${assetId}`)
    const existing = getStems(assetId)
    const valid = existing.length === STEM_TYPES.length && STEM_TYPES.every((type) =>
      existing.filter((stem) => stem.stemType === type && existsSync(stem.path)).length === 1)
    if (valid) {
      const { decodeWavFile } = await import('./audio/wav.js')
      try { await Promise.all(existing.map((stem) => decodeWavFile(stem.path))) }
      catch { throw new MvsepError('SPLIT_FILES_INVALID', 'Existing split files are invalid. No new split was submitted.', false,
        'Inspect and repair the files before explicitly authorizing replacement paid work.', 'queued') }
      const m = newJobManifest('split', `spl-${randomUUID().slice(0, 8)}`, asset.projectId, asset.name, { assetId }, { assetId })
      m.status = 'completed'; m.stage = 'Existing seven valid stems reused; nothing spent.'
      m.stems = existing.map((stem) => ({ stemType: stem.stemType, path: stem.path }))
      await saveJob(m)
      return m
    }
    const prep = await prepareSplit(assetId)
    const m = newJobManifest('split', `spl-${randomUUID().slice(0, 8)}`, asset.projectId, asset.name, { assetId },
      { assetId, stemsDir: prep.stemsDir })
    await saveJob(m)
    return m
  } finally { await release() }
}

/** Cancellation intent is durable even while an advance holds the lease. An interaction already
 * in progress settles; no subsequent paid request or landing unit starts. */
export async function cancelJob(jobId: string): Promise<JobManifest> {
  const m = await loadJob(jobId)
  if (!m) throw new MvsepError('JOB_NOT_FOUND', `Job ${jobId} was not found.`, false, 'Use listJobs for valid ids.', 'cancel')
  if (!isJobActive(m)) return m
  const file = await open(`${jobPath(jobId)}.cancel`, 'wx').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
    return null
  })
  if (file) { try { await file.writeFile(new Date().toISOString()); await file.sync() } finally { await file.close() } }
  const release = await acquireLease(jobId)
  try {
    const fresh = (await loadJob(jobId)) ?? m
    if (release) await saveJob(fresh)
    return fresh
  } finally { await release?.() }
}

const advanceLocks = new Map<string, Promise<JobManifest>>()

/** Advance a running job by ONE provider poll, landing whatever is ready.
 *  Idempotent and serialized per jobId — the status op can hit it repeatedly. */
export async function advanceJob(m: JobManifest, signal?: AbortSignal): Promise<JobManifest> {
  const inFlight = advanceLocks.get(m.jobId)
  if (inFlight) return inFlight

  const run = (async (): Promise<JobManifest> => {
    const release = await acquireLease(m.jobId)
    if (!release) return (await loadJob(m.jobId)) ?? m
    let sourceRelease: (() => Promise<void>) | null = null
    try {
      const fresh = (await loadJob(m.jobId)) ?? m
      if (!isJobActive(fresh)) return fresh
      const assetId = fresh.provider.assetId ?? fresh.provider.extract?.assetId
      if (assetId && (fresh.kind === 'split' || fresh.kind === 'extract')) {
        sourceRelease = await acquireLease(sourceLeaseKey(fresh.kind, assetId))
        if (!sourceRelease) return fresh
        // Prefer already accepted work, otherwise the earliest compatible plan.
        const peers = (await listJobs()).filter((job) => job.kind === fresh.kind && isJobActive(job) &&
          (job.provider.assetId ?? job.provider.extract?.assetId) === assetId &&
          (fresh.kind !== 'extract' || JSON.stringify(job.provider.extract?.calls) === JSON.stringify(fresh.provider.extract?.calls)))
        peers.sort((a, b) => Number(Boolean(b.provider.hashes && Object.keys(b.provider.hashes).length || b.provider.extract?.currentHash)) -
          Number(Boolean(a.provider.hashes && Object.keys(a.provider.hashes).length || a.provider.extract?.currentHash)) ||
          a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId))
        if (peers[0] && peers[0].jobId !== fresh.jobId) {
          fresh.duplicateOf = peers[0].jobId
          fresh.lastError = { code: 'JOB_DUPLICATE', message: `Compatible work exists as job ${peers[0].jobId}.`,
            retryable: false, nextAction: `Reuse job ${peers[0].jobId}; no duplicate paid call was submitted.` }
          const alreadyPaid = Boolean(fresh.provider.hashes && Object.keys(fresh.provider.hashes).length ||
            fresh.provider.extract?.currentHash || fresh.provider.extract?.callResults?.some((call) => call.hash))
          if (!alreadyPaid) {
            fresh.status = 'failed'; fresh.stage = fresh.lastError.message; fresh.error = fresh.lastError.message
            await saveJob(fresh)
            return fresh
          }
          // Reconcile old paid hashes, but suppress any further duplicate submissions.
        }
      }
      // This save is mandatory even for a manifest passed directly by a caller.
      await saveJob(fresh)
      try {
        if (await stopped(fresh, signal)) return fresh
        if (fresh.kind === 'split') await advanceSplit(fresh, signal)
        else if (fresh.kind === 'extract') await advanceExtract(fresh, signal)
        else await advanceGeneration(fresh, signal)
      } catch (error) {
        fresh.lastError = separationError(error, fresh.status)
        if (!fresh.lastError.retryable) {
          fresh.status = fresh.stems.length > 0 ? 'partial' : 'failed'
          fresh.error = fresh.lastError.message
          fresh.stage = `${fresh.lastError.code}: ${fresh.lastError.message}`
        }
      }
      await saveJob(fresh)
      return fresh
    } finally {
      await sourceRelease?.()
      await release()
    }
  })()

  advanceLocks.set(m.jobId, run)
  try {
    return await run
  } finally {
    advanceLocks.delete(m.jobId)
  }
}

async function advanceGeneration(m: JobManifest, signal?: AbortSignal): Promise<void> {
  const taskId = m.provider.taskId
  if (!taskId) throw new Error('Job manifest has no provider taskId')

  const record = await fetchGenerationRecord(taskId)
  m.lastStatus = record.status
  // Monotonic grow only — providers can drop streamAudioUrl from later
  // responses; never shrink a previously-seen preview list.
  const streams = record.variations
    .map((v) => v.streamAudioUrl)
    .filter((u): u is string => Boolean(u))
  if (streams.length > (m.streamUrls?.length ?? 0)) m.streamUrls = streams

  if (record.status === 'SUCCESS' || record.status === 'CALLBACK_EXCEPTION') {
    const ready = record.variations.filter((v) => v.audioUrl)
    if (ready.length === 0) {
      if (record.status === 'SUCCESS') {
        throw new Error('Provider reported SUCCESS but returned no audio URLs')
      }
      m.stage = 'finishing (callback grace window)'
      return
    }
    if (!m.landed.assets) {
      m.status = 'landing'; m.stage = 'downloading variations'
      await landGenerationAssets(m, ready, signal)
      if (await stopped(m, signal)) return
      m.landed.assets = true
    }
    if (await stopped(m, signal)) return
    m.status = 'completed'
    m.stage = 'complete'
    return
  }

  if (isGenerationFailure(record.status)) {
    throw new Error(
      `Generation failed (${record.status}): ${generationFailureDetail(record)}`
    )
  }

  m.status = 'waiting'
  m.stage =
    (m.streamUrls?.length ?? 0) > 0
      ? `generating (${record.status}) — stream preview available`
      : `generating (${record.status})`
}

async function advanceSplit(m: JobManifest, signal?: AbortSignal): Promise<void> {
  const { assetId, stemsDir } = m.provider
  if (!assetId || !stemsDir) throw new Error('Split job manifest is incomplete')
  const asset = getAsset(assetId)
  if (!asset) throw new Error(`Split source asset no longer exists: ${assetId}`)
  const names = Object.keys(SPLIT_ROUTES) as SplitJobName[]
  m.provider.hashes ??= {}
  m.provider.splitAttempts ??= {}
  const attempts = m.provider.splitAttempts
  for (const name of names) {
    attempts[name] ??= { routeId: SPLIT_ROUTES[name].id,
      status: m.landed[name] ? 'landed' : m.provider.hashes[name] ? 'accepted' : 'pending',
      hash: m.provider.hashes[name], deliveredStemIds: [] }
    const attempt = attempts[name]!
    // A dead process may have sent this POST. Never assume a missing hash means no spend.
    if (attempt.status === 'submitting' && attempt.hash) attempt.status = 'accepted'
    if (attempt.status === 'submitting' && !attempt.hash) {
      attempt.status = 'uncertain'
      attempt.error = { code: 'MVSEP_UNCERTAIN_SUBMIT', message: 'Submission interrupted before its hash was saved.', retryable: false,
        nextAction: `Check MVSEP history for upload ${attempt.uploadName ?? 'unknown'} at ${attempt.submittedAt ?? 'unknown time'} and reconcile its hash.` }
      m.lastError = attempt.error
      await saveJob(m)
    }
  }

  // Each route settles independently: a failed poll never blocks another ready result.
  const accepted = names.filter((name) => attempts[name]!.status === 'accepted')
  const statuses = await Promise.allSettled(accepted.map((name) => fetchSeparationStatus(attempts[name]!.hash!)))
  for (let i = 0; i < accepted.length; i++) {
    if (await stopped(m, signal)) return
    const name = accepted[i]
    const attempt = attempts[name]!
    let stage = 'poll'
    try {
      const polled = statuses[i]
      if (polled.status === 'rejected') throw polled.reason
      const result = resolveSeparationStatus(attempt.hash!, polled.value)
      m.lastStatus = `${name}: ${polled.value.status}`
      if (!result) continue
      stage = 'landing'; m.status = 'landing'; m.stage = `checking and landing ${name}`
      await saveJob(m)
      if (await stopped(m, signal)) return
      const input = await readFile(join(stemsDir, 'original.wav'))
      if (attempt.inputDigest && createHash('sha256').update(input).digest('hex') !== attempt.inputDigest) {
        throw new MvsepError('SEPARATION_INPUT_CHANGED', 'The split input changed after submission.', false,
          'Restore the original input recorded by the attempt before checking its result.', stage)
      }
      const rows = await landSplitJob(name, result, asset, stemsDir, attempt.hash!, async (run) => {
        attempt.checks = describeSeparationResult(SPLIT_ROUTES[name].id, result, run)
        await saveJob(m)
      }, input)
      for (const row of rows) {
        m.stems = m.stems.filter((stem) => stem.stemType !== row.stemType)
        m.stems.push({ stemType: row.stemType, path: row.path })
      }
      attempt.status = 'landed'; attempt.deliveredStemIds = rows.map((row) => row.stemType)
      delete attempt.error
      m.landed[name] = true
      await saveJob(m)
    } catch (error) {
      attempt.error = separationError(error, stage); m.lastError = attempt.error
      if (!attempt.error.retryable) attempt.status = 'failed'
      // A download retry remains in landing; polling failures remain in waiting.
      m.status = stage === 'landing' && attempt.error.retryable ? 'landing' : 'waiting'
      m.stage = `${name}: ${attempt.error.code}: ${attempt.error.message}`
      await saveJob(m)
    }
  }

  if (names.every((name) => attempts[name]!.status === 'landed')) {
    if (await stopped(m, signal)) return
    if (!m.landed.other) {
      m.status = 'landing'; m.stage = 'building Other'; await saveJob(m)
      if (await stopped(m, signal)) return
      const row = await finalizeSplit(asset, stemsDir)
      m.stems.push({ stemType: row.stemType, path: row.path })
      m.landed.other = true
    }
    m.status = 'completed'; m.stage = 'complete — 7 checked stems landed'
    delete m.lastError
    return
  }

  const uncertain = names.some((name) => attempts[name]!.status === 'uncertain')
  if (m.duplicateOf) for (const name of names) {
    if (attempts[name]!.status === 'pending') {
      attempts[name]!.status = 'failed'
      attempts[name]!.error = { code: 'JOB_DUPLICATE', message: `Further submissions suppressed; use job ${m.duplicateOf}.`,
        retryable: false, nextAction: `Reuse job ${m.duplicateOf}. Already-paid hashes in this job are still reconciled.` }
    }
  }
  const next = names.find((name) => attempts[name]!.status === 'pending')
  if (next && !uncertain) {
    if (await stopped(m, signal)) return
    // Preserve the 2 s create stagger even across rapidly repeated CLI status calls.
    if (m.provider.lastSubmittedAt && Date.now() - Date.parse(m.provider.lastSubmittedAt) < 2000) {
      m.status = 'queued'; m.stage = 'waiting for the 2 s submission stagger'; return
    }
    const attempt = attempts[next]!
    const inputPath = join(stemsDir, 'original.wav')
    const input = await readFile(inputPath)
    try {
      await submitRoute({ ...mvsepProvider, async createJob(audio, spec, uploadName) {
        const durableName = attempt.uploadName ?? uploadName
        Object.assign(attempt, { status: 'submitting', uploadName: durableName, spec, inputPath,
          inputDigest: createHash('sha256').update(audio).digest('hex'), submittedAt: new Date().toISOString() })
        m.provider.lastSubmittedAt = attempt.submittedAt
        m.status = 'submitting'; m.stage = `submitting ${next}`
        await saveJob(m)
        if (await stopped(m, signal)) throw new MvsepError(signal?.aborted ? 'REQUEST_ABORTED' : 'JOB_CANCELLED',
          'Submission stopped before the paid request.', Boolean(signal?.aborted), 'Advance the saved job to resume; already-submitted MVSEP work may still run.', 'submitting')
        const { hash } = await mvsepProvider.createJob(audio, spec, durableName)
        attempt.hash = hash; attempt.status = 'accepted'; m.provider.hashes![next] = hash
        m.provider.lastSubmittedAt = new Date().toISOString()
        m.status = 'waiting'; m.stage = `submitted ${next}`
        await saveJob(m)
        return { hash }
      } }, { route: SPLIT_ROUTES[next], input })
    } catch (error) {
      if (attempt.hash) {
        // Hash received but its save failed: keep it in memory and try saving again, never re-create.
        attempt.status = 'accepted'
        m.lastError = { code: 'JOB_SAVE_FAILED', message: 'Accepted hash could not be saved on the first attempt.',
          retryable: true, nextAction: 'Restore manifest storage access; retain this hash.' }
      } else {
        attempt.error = separationError(error, 'submitting'); m.lastError = attempt.error
        attempt.status = attempt.error.code === 'MVSEP_UNCERTAIN_SUBMIT' ? 'uncertain' : attempt.error.retryable ? 'pending' : 'failed'
      }
      await saveJob(m)
    }
  }
  if (await stopped(m, signal)) return
  const inFlight = names.some((name) => attempts[name]!.status === 'accepted' || attempts[name]!.status === 'pending' && !uncertain)
  if (!inFlight) {
    m.status = m.stems.length > 0 ? 'partial' : 'failed'
    m.error = names.map((name) => attempts[name]!.error?.message).filter(Boolean).join('; ')
    m.stage = `${m.status}: ${names.filter((name) => m.landed[name]).length}/3 routes landed${uncertain ? '; reconcile uncertain submission before any further paid work' : ''}`
  } else if (m.status !== 'landing') {
    m.status = 'waiting'
    m.stage = `separating (${names.filter((name) => m.landed[name]).length}/3 routes landed)`
  }
}

/** Advance the extract state machine by ONE provider interaction: submit the
 *  next planned call, or poll the in-flight one and land its files. A failed
 *  call is recorded and skipped (partial results survive — prism behavior);
 *  after the last call, Other synthesis + DB persistence finalize the run. */
async function advanceExtract(m: JobManifest, signal?: AbortSignal): Promise<void> {
  const state = m.provider.extract
  if (!state) throw new Error('Extract job manifest is incomplete')
  const asset = getAsset(state.assetId)
  if (!asset) throw new Error(`Extract source asset no longer exists: ${state.assetId}`)

  const total = state.calls.length
  state.callResults ??= state.calls.map((call, index) => ({ routeId: call.routeId,
    status: index < state.callIndex ? 'landed' : index === state.callIndex && state.currentHash ? 'accepted' : 'pending',
    hash: index === state.callIndex ? state.currentHash ?? undefined : undefined, deliveredStemIds: [] }))
  if (await stopped(m, signal)) return
  if (m.duplicateOf && !state.currentHash) while (state.callIndex < total) {
    failExtractCall(state, { code: 'JOB_DUPLICATE', message: `Further submissions suppressed; use job ${m.duplicateOf}.`,
      retryable: false, nextAction: `Reuse job ${m.duplicateOf}. Already-landed outputs stay.` })
  }

  // All calls settled → finalize once.
  if (state.callIndex >= total) {
    m.status = 'landing'; m.stage = 'building Other'; await saveJob(m)
    if (await stopped(m, signal)) return
    const rows = await finalizeExtract(asset, state)
    m.stems = rows.map((r) => ({ stemType: r.stemId, path: r.path }))
    m.status = state.failures.length > 0 ? 'partial' : 'completed'
    const failNote = state.failures.length > 0 ? `; ${state.failures.length} call(s) failed` : ''
    m.stage = `complete — ${rows.length} stems landed${failNote}`
    return
  }

  const call = state.calls[state.callIndex]
  const attempt = state.callResults[state.callIndex]
  if (attempt.hash && !state.currentHash) state.currentHash = attempt.hash
  if (state.currentHash && attempt.status === 'submitting') attempt.status = 'accepted'
  if (attempt.status === 'submitting' || attempt.status === 'uncertain') {
    attempt.status = 'uncertain'
    attempt.error ??= { code: 'MVSEP_UNCERTAIN_SUBMIT', message: 'Submission interrupted without a saved hash.', retryable: false,
      nextAction: `Check MVSEP history for ${attempt.uploadName ?? 'the saved upload name'} and reconcile its hash; do not resubmit.` }
    m.lastError = attempt.error
    m.status = m.stems.length > 0 ? 'partial' : 'failed'; m.error = attempt.error.message
    m.stage = 'uncertain submission; remaining paid calls paused for reconciliation'
    return
  }

  // No in-flight hash → submit the next call.
  if (!state.currentHash) {
    if (state.lastSubmittedAt && Date.now() - Date.parse(state.lastSubmittedAt) < 2000) {
      m.status = 'queued'; m.stage = 'waiting for the 2 s submission stagger'; return
    }
    try {
      m.status = 'submitting'
      await submitNextExtractCall(state, async () => {
        await saveJob(m)
        if (!state.currentHash && await stopped(m, signal)) throw new MvsepError(signal?.aborted ? 'REQUEST_ABORTED' : 'JOB_CANCELLED',
          'Submission stopped before the paid request.', Boolean(signal?.aborted), 'Advance the saved job to resume; already-submitted MVSEP work may still run.', 'submitting')
      })
      m.status = 'waiting'
      m.stage = `submitted ${call.outputType} (${state.callIndex + 1}/${total})`
    } catch (error) {
      if (state.currentHash) { m.status = 'waiting'; return }
      const detail = separationError(error, 'submitting'); m.lastError = detail
      if (detail.code === 'MVSEP_UNCERTAIN_SUBMIT') {
        attempt.status = 'uncertain'; attempt.error = detail
        m.status = m.stems.length > 0 ? 'partial' : 'failed'; m.error = detail.message
        m.stage = 'uncertain submission; remaining paid calls paused for reconciliation'
      } else if (detail.retryable) {
        attempt.status = 'pending'; attempt.error = detail; m.status = 'queued'
        m.stage = `${call.outputType}: ${detail.message}`
      } else {
        failExtractCall(state, detail); m.status = 'queued'
        m.stage = `${call.outputType} refused; continuing the remaining plan`
      }
    }
    return
  }

  // Poll the in-flight call once.
  let stage = 'poll'
  let landed = false
  try {
    const status = await fetchSeparationStatus(state.currentHash)
    const result = resolveSeparationStatus(state.currentHash, status)
    m.lastStatus = status.status
    if (result) {
      stage = 'landing'; m.status = 'landing'; m.stage = `checking and landing ${call.outputType}`
      await saveJob(m)
      if (await stopped(m, signal)) return
      await landExtractCall(state, result)
      landed = true
      for (const stemId of attempt.deliveredStemIds) {
        const path = state.extractedFiles[stemId]
        m.stems = m.stems.filter((stem) => stem.stemType !== stemId)
        m.stems.push({ stemType: stemId, path })
      }
      await saveJob(m)
      m.status = 'queued'
      m.stage = `${call.outputType} landed (${state.callIndex}/${total} calls)`
    } else {
      m.status = 'waiting'
      m.stage = `separating ${call.outputType} (${state.callIndex + 1}/${total}): ${status.status}`
    }
  } catch (error) {
    if (landed) {
      // The call index has advanced. A failed manifest save must never fail or skip the next call.
      m.lastError = { code: 'JOB_SAVE_FAILED', message: 'Checked extraction landed, but its manifest save needs retrying.',
        retryable: true, nextAction: 'Restore manifest storage access. The next paid call has not been submitted.' }
      m.status = 'queued'; m.stage = 'saving the checked extraction landing'
      return
    }
    const detail = separationError(error, stage); m.lastError = detail; attempt.error = detail
    if (detail.retryable) {
      m.status = stage === 'landing' ? 'landing' : 'waiting'
      m.stage = `${call.outputType}: ${detail.message}; retrying the same hash on next advance`
    } else {
      failExtractCall(state, detail); m.status = 'queued'
      m.stage = `${call.outputType} failed (${state.callIndex}/${total} done); continuing`
    }
  }
}
