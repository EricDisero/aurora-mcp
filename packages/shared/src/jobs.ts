// Background-job model. Long ops (generate / sounds / cover / split) can submit
// and return immediately; the job's provider handles (taskId / MVSEP hashes)
// persist to userData/agent-jobs/<jobId>.json, so status survives process
// restarts — aurora_get_job_status re-polls the PROVIDER, not in-process state,
// and finishes downloads/DB-landing the moment results are ready (per-stem
// progressive for splits). Mirrors the bridge's job.json manifest discipline.

import { join, extname } from 'node:path'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getJobsDir } from './paths.js'
import {
  downloadTo,
  fetchGenerationRecord,
  isGenerationFailure
} from './providers/suno.js'
import { fetchSeparationStatus, resolveSeparationStatus } from './providers/mvsep.js'
import { ensureKindDir, getAsset, insertAsset, uniqueDestPath } from './storage/assets.js'
import { landSplitJob, finalizeSplit, type SplitJobName } from './split.js'
import {
  failExtractCall,
  finalizeExtract,
  landExtractCall,
  submitNextExtractCall,
  type ExtractJobState
} from './extract.js'
import type { ProjectAsset } from './types.js'

export type JobKind =
  | 'generate'
  | 'sounds'
  | 'cover'
  | 'add_vocals'
  | 'add_instrumental'
  | 'split'
  | 'extract'

export interface JobManifest {
  jobId: string
  kind: JobKind
  status: 'running' | 'done' | 'error'
  error?: string
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
    hashes?: Record<SplitJobName, string>
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
  return join(getJobsDir(), `${jobId}.json`)
}

export async function saveJob(m: JobManifest): Promise<void> {
  m.updatedAt = new Date().toISOString()
  await mkdir(getJobsDir(), { recursive: true })
  await writeFile(jobPath(m.jobId), JSON.stringify(m, null, 2))
}

export async function loadJob(jobId: string): Promise<JobManifest | null> {
  const p = jobPath(jobId)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(await readFile(p, 'utf-8')) as JobManifest
  } catch {
    return null
  }
}

export async function listJobs(): Promise<JobManifest[]> {
  const dir = getJobsDir()
  if (!existsSync(dir)) return []
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  const jobs: JobManifest[] = []
  for (const f of files) {
    try {
      jobs.push(JSON.parse(await readFile(join(dir, f), 'utf-8')) as JobManifest)
    } catch {
      // skip unreadable manifests
    }
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
  return {
    jobId,
    kind,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    projectId,
    baseName,
    params,
    provider,
    landed: {},
    assetIds: [],
    stems: [],
    stage: 'submitted'
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
  variations: Array<{ id?: string; audioUrl?: string }>
): Promise<void> {
  const kind = m.kind === 'cover' ? 'cover' : 'generation'
  const outputDir = await ensureKindDir(m.projectId, kind, m.trackId)

  for (let i = 0; i < variations.length; i++) {
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
        taskId: m.provider.taskId,
        audioId: v.id ?? null
      },
      sourceAssetId: m.provider.sourceAssetId ?? null
    })
    m.assetIds.push(asset.id)
  }
}

// Per-job serialization: two concurrent status polls advancing the same job
// would double-land assets (both read landed=false, both download + insert).
// Within this process, the second caller awaits the first and gets its result.
// (Cross-process races — CLI + MCP simultaneously — are narrowed by the fresh
// manifest re-read below, not fully eliminated; acceptable for v1 dogfood.)
const advanceLocks = new Map<string, Promise<JobManifest>>()

/** Advance a running job by ONE provider poll, landing whatever is ready.
 *  Idempotent and serialized per jobId — the status op can hit it repeatedly. */
export async function advanceJob(m: JobManifest): Promise<JobManifest> {
  if (m.status !== 'running') return m

  const inFlight = advanceLocks.get(m.jobId)
  if (inFlight) return inFlight

  const run = (async (): Promise<JobManifest> => {
    // Re-read disk state so a concurrent process's landing isn't repeated.
    const fresh = (await loadJob(m.jobId)) ?? m
    if (fresh.status !== 'running') return fresh

    try {
      if (fresh.kind === 'split') {
        await advanceSplit(fresh)
      } else if (fresh.kind === 'extract') {
        await advanceExtract(fresh)
      } else {
        await advanceGeneration(fresh)
      }
    } catch (err) {
      fresh.status = 'error'
      fresh.error = err instanceof Error ? err.message : String(err)
      fresh.stage = 'error'
    }

    await saveJob(fresh)
    return fresh
  })()

  advanceLocks.set(m.jobId, run)
  try {
    return await run
  } finally {
    advanceLocks.delete(m.jobId)
  }
}

async function advanceGeneration(m: JobManifest): Promise<void> {
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
      m.stage = 'downloading variations'
      await landGenerationAssets(m, ready)
      m.landed.assets = true
    }
    m.status = 'done'
    m.stage = 'complete'
    return
  }

  if (isGenerationFailure(record.status)) {
    throw new Error(`Generation failed with status: ${record.status}`)
  }

  m.stage =
    (m.streamUrls?.length ?? 0) > 0
      ? `generating (${record.status}) — stream preview available`
      : `generating (${record.status})`
}

async function advanceSplit(m: JobManifest): Promise<void> {
  const { hashes, assetId, stemsDir } = m.provider
  if (!hashes || !assetId || !stemsDir) throw new Error('Split job manifest is incomplete')
  const asset = getAsset(assetId)
  if (!asset) throw new Error(`Split source asset no longer exists: ${assetId}`)

  const jobNames: SplitJobName[] = ['vocals', 'drumsep', 'bass']
  const pendingStates: string[] = []

  // Poll the pending hashes in parallel — one status round-trip per poll, not three.
  const pending = jobNames.filter((j) => !m.landed[j])
  const statuses = await Promise.all(pending.map((j) => fetchSeparationStatus(hashes[j])))

  for (let i = 0; i < pending.length; i++) {
    const job = pending[i]
    const files = resolveSeparationStatus(hashes[job], statuses[i])
    if (files) {
      const rows = await landSplitJob(job, files, asset as ProjectAsset, stemsDir)
      m.stems.push(...rows.map((r) => ({ stemType: r.stemType, path: r.path })))
      m.landed[job] = true
    } else {
      pendingStates.push(`${job}: ${statuses[i].status}`)
    }
  }

  if (jobNames.every((j) => m.landed[j])) {
    if (!m.landed.ee) {
      const row = await finalizeSplit(asset as ProjectAsset, stemsDir)
      m.stems.push({ stemType: row.stemType, path: row.path })
      m.landed.ee = true
    }
    m.status = 'done'
    m.stage = 'complete — 7 stems landed'
    return
  }

  const landedCount = jobNames.filter((j) => m.landed[j]).length
  m.stage = `separating (${landedCount}/3 jobs landed; ${pendingStates.join(', ')})`
}

/** Advance the extract state machine by ONE provider interaction: submit the
 *  next planned call, or poll the in-flight one and land its files. A failed
 *  call is recorded and skipped (partial results survive — prism behavior);
 *  after the last call, EE synthesis + DB persistence finalize the run. */
async function advanceExtract(m: JobManifest): Promise<void> {
  const state = m.provider.extract
  if (!state) throw new Error('Extract job manifest is incomplete')
  const asset = getAsset(state.assetId)
  if (!asset) throw new Error(`Extract source asset no longer exists: ${state.assetId}`)

  const total = state.calls.length

  // All calls settled → finalize once.
  if (state.callIndex >= total) {
    m.stage = 'building everything-else'
    const rows = await finalizeExtract(asset as ProjectAsset, state)
    m.stems.push(...rows.map((r) => ({ stemType: r.stemId, path: r.path })))
    m.status = 'done'
    const failNote = state.failures.length > 0 ? `; ${state.failures.length} call(s) failed` : ''
    m.stage = `complete — ${rows.length} stems landed${failNote}`
    return
  }

  const call = state.calls[state.callIndex]

  // No in-flight hash → submit the next call.
  if (!state.currentHash) {
    try {
      await submitNextExtractCall(state)
      m.stage = `submitted ${call.outputType} (${state.callIndex + 1}/${total})`
    } catch (err) {
      failExtractCall(state, err instanceof Error ? err.message : String(err))
      m.stage = `${call.outputType} failed at create (${state.callIndex}/${total} done) — continuing`
    }
    return
  }

  // Poll the in-flight call once.
  try {
    const status = await fetchSeparationStatus(state.currentHash)
    const files = resolveSeparationStatus(state.currentHash, status)
    if (files) {
      await landExtractCall(state, files)
      m.stage = `${call.outputType} landed (${state.callIndex}/${total} calls)`
    } else {
      m.stage = `separating ${call.outputType} (${state.callIndex + 1}/${total}): ${status.status}`
    }
  } catch (err) {
    failExtractCall(state, err instanceof Error ? err.message : String(err))
    m.stage = `${call.outputType} failed (${state.callIndex}/${total} done) — continuing`
  }
}
