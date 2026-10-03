// Sample Extractor orchestration helpers — port of aurora
// src/main/extract/orchestrate.ts, restructured for the background-job model:
// the job advances ONE provider interaction at a time (submit a call, or poll
// the in-flight one), so aurora_get_job_status drives a sequential MVSEP plan
// across process restarts. Dereverb chains its dry vocal into the vocal
// bundle; EE phase-cancels every delivered stem from the standardized
// original; a single failed call keeps the run alive with partial results.
//
// LOCKSTEP: behavior mirrors the app orchestrator — changes go into both.

import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { mvsepProvider, MvsepError, separationError } from './providers/mvsep.js'
import { ALL_ROUTES } from './separation/routes.js'
import { submitRoute, landRouteResult } from './separation/run-route.js'
import { describeSeparationResult } from './separation-tools.js'
import { getAsset, getAssetExtractsDir } from './storage/assets.js'
import { upsertExtractionStem } from './storage/extractions.js'
import { probeDurationSeconds, standardizeToWav } from './audio/ffmpeg.js'
import { decodeWavFile, encodeWavFloat32File, subtractWavs } from './audio/wav.js'
import { detectKey } from './key-detect.js'
import {
  EXTRACT_MAX_DURATION_SECONDS,
  planApiCalls,
  type ExtractSelection,
  type PlannedApiCall
} from './extract-catalog.js'
import type { ExtractionStem, ProjectAsset, SeparationAttempt, SeparationResult } from './types.js'

/** Serialized extract state carried by the job manifest's provider blob. */
export interface ExtractJobState {
  assetId: string
  extractDir: string
  originalPath: string
  calls: PlannedApiCall[]
  /** Index of the NEXT call to submit (or the in-flight one when hash is set). */
  callIndex: number
  /** In-flight MVSEP hash for calls[callIndex], if submitted. */
  currentHash: string | null
  /** Dereverb's dry vocal (chained into the vocal bundle when present). */
  vocalDryPath: string | null
  /** stemId → local path, accumulated as calls land. */
  extractedFiles: Record<string, string>
  detectedKey: string | null
  /** outputType: message, for calls that failed (run continues). */
  failures: string[]
  requestedStemIds?: string[]
  callResults?: SeparationAttempt[]
  lastSubmittedAt?: string
}

function callAttempt(state: ExtractJobState): SeparationAttempt {
  state.callResults ??= state.calls.map((call) => ({ routeId: call.routeId, status: 'pending', deliveredStemIds: [] }))
  return state.callResults[state.callIndex]
}

function callInputPath(state: ExtractJobState): string {
  const call = state.calls[state.callIndex]
  // Match the app's fallback after a failed dereverb.
  return call.inputSource === 'dry' && state.vocalDryPath ? state.vocalDryPath : state.originalPath
}

function callOptions(state: ExtractJobState): { add_opt2: string } | undefined {
  const call = state.calls[state.callIndex]
  return call.addOpt2 === undefined ? undefined : { add_opt2: String(call.addOpt2) }
}

/** Cap + standardize + key-detect + plan. Runs ONCE at op time, before any
 *  MVSEP spend. Returns the job state seed. */
export async function prepareExtract(
  assetId: string,
  selection: ExtractSelection
): Promise<{ asset: ProjectAsset; state: ExtractJobState }> {
  const asset = getAsset(assetId)
  if (!asset) throw new Error(`Asset not found: ${assetId}`)

  const plan = planApiCalls(selection)
  if (plan.calls.length === 0) {
    throw new Error('Nothing selected — pick at least one instrument or a vocal mode.')
  }

  const duration = await probeDurationSeconds(asset.path)
  if (duration !== null && duration > EXTRACT_MAX_DURATION_SECONDS) {
    throw new Error(
      `Track is ${Math.round(duration)}s — extraction caps at 12 minutes. Export a shorter section.`
    )
  }

  const extractDir = getAssetExtractsDir(asset)
  await mkdir(extractDir, { recursive: true })

  const originalPath = join(extractDir, 'original.wav')
  await standardizeToWav(asset.path, originalPath)
  const detectedKey = await detectKey(originalPath)

  return {
    asset,
    state: {
      assetId,
      extractDir,
      originalPath,
      calls: plan.calls,
      callIndex: 0,
      currentHash: null,
      vocalDryPath: null,
      extractedFiles: {},
      detectedKey,
      failures: [],
      requestedStemIds: plan.stemsToDeliver,
      callResults: plan.calls.map((call) => ({ routeId: call.routeId, status: 'pending', deliveredStemIds: [] }))
    }
  }
}

/** Submit the next planned call. Mutates state (currentHash). */
export async function submitNextExtractCall(
  state: ExtractJobState, persist?: () => Promise<void>
): Promise<void> {
  if (!persist) throw new MvsepError('JOB_MANIFEST_REQUIRED', 'Extraction submission requires a saved planned manifest.',
    false, 'Advance the extraction through advanceJob(manifest).', 'queued')
  const call = state.calls[state.callIndex]
  const route = ALL_ROUTES[call.routeId]
  if (!route) throw new Error(`No separation route "${call.routeId}"`)
  const attempt = callAttempt(state)
  if (attempt.status !== 'pending' || state.currentHash) throw new Error('This extraction call is already submitted or needs reconciliation')
  const inputPath = callInputPath(state)
  const audio = await readFile(inputPath)
  await submitRoute({
    ...mvsepProvider,
    async createJob(input, spec, uploadName) {
      const durableName = attempt.uploadName ?? uploadName
      Object.assign(attempt, { status: 'submitting', spec, uploadName: durableName, inputPath,
        inputDigest: createHash('sha256').update(input).digest('hex'), submittedAt: new Date().toISOString() })
      state.lastSubmittedAt = attempt.submittedAt
      await persist()
      const { hash } = await mvsepProvider.createJob(input, spec, durableName)
      state.currentHash = hash
      state.lastSubmittedAt = new Date().toISOString()
      Object.assign(attempt, { status: 'accepted', hash })
      await persist()
      return { hash }
    }
  }, { route, input: audio, optionOverrides: callOptions(state) })
}

/** Land a finished call's files. Mutates state (extractedFiles / vocalDryPath),
 *  then advances callIndex and clears the hash. */
export async function landExtractCall(
  state: ExtractJobState,
  result: SeparationResult
): Promise<void> {
  const call = state.calls[state.callIndex]
  const route = ALL_ROUTES[call.routeId]
  if (!route) throw new Error(`No separation route "${call.routeId}"`)
  const attempt = callAttempt(state)
  attempt.hash ??= state.currentHash ?? undefined
  const input = await readFile(attempt.inputPath ?? callInputPath(state))
  if (attempt.inputDigest && createHash('sha256').update(input).digest('hex') !== attempt.inputDigest) {
    throw new MvsepError('SEPARATION_INPUT_CHANGED', 'The extraction input changed after submission.', false,
      'Restore the exact input bytes recorded by this attempt before checking its paid result.', 'landing')
  }
  const run = await landRouteResult(state.currentHash ?? attempt.hash ?? 'unknown', result, {
    route, input, destDir: state.extractDir, optionOverrides: attempt.spec ?? callOptions(state)
  })

  const delivered: string[] = []
  for (const [stemKey, dest] of Object.entries(run.stems)) {

    if (call.type === 'dereverb') {
      if (stemKey === 'vocal_dry') {
        state.vocalDryPath = dest
        // Deliver vocal_dry only in reverb-only mode (no vocal bundle).
        if (call.deliverVocalDry) { state.extractedFiles.vocal_dry = dest; delivered.push(stemKey) }
      } else if (stemKey === 'vocal_reverb') {
        state.extractedFiles.vocal_reverb = dest
        delivered.push(stemKey)
      }
    } else {
      state.extractedFiles[stemKey] = dest
      delivered.push(stemKey)
    }
  }
  const asset = getAsset(state.assetId)
  if (!asset) throw new Error(`Extract source asset no longer exists: ${state.assetId}`)
  for (const stemId of delivered) {
    upsertExtractionStem({ projectId: asset.projectId, assetId: asset.id, stemId,
      path: state.extractedFiles[stemId], detectedKey: state.detectedKey })
  }
  Object.assign(attempt, { status: 'landed', deliveredStemIds: delivered,
    checks: describeSeparationResult(route.id, result, run) })
  delete attempt.error
  state.callIndex++
  state.currentHash = null
}

/** Record a failed call and move on (prism behavior: partial results survive). */
export function failExtractCall(state: ExtractJobState, error: unknown): void {
  const call = state.calls[state.callIndex]
  const detail = typeof error === 'object' && error !== null && 'code' in error && 'nextAction' in error
    ? error as import('./types.js').JobError : separationError(error)
  const attempt = callAttempt(state)
  Object.assign(attempt, { status: 'failed', error: detail, hash: attempt.hash ?? state.currentHash ?? undefined })
  state.failures.push(`${call?.outputType ?? 'call'}: ${detail.code}: ${detail.message}`)
  state.callIndex++
  state.currentHash = null
}

/** EE synthesis + DB persistence. Runs once after the last call. */
export async function finalizeExtract(
  asset: ProjectAsset,
  state: ExtractJobState
): Promise<ExtractionStem[]> {
  if (Object.keys(state.extractedFiles).length === 0) {
    throw new Error(`No stems extracted — every separation failed. ${state.failures.join('; ')}`)
  }

  const original = await decodeWavFile(state.originalPath)
  const stems = await Promise.all(
    Object.entries(state.extractedFiles).filter(([id]) => id !== 'ee').map(([, path]) => decodeWavFile(path))
  )
  const ee = subtractWavs(original, ...stems)
  const eePath = join(state.extractDir, 'ee.wav')
  await encodeWavFloat32File(eePath, ee.channels, ee.sampleRate)
  state.extractedFiles.ee = eePath

  const rows: ExtractionStem[] = []
  for (const [stemId, path] of Object.entries(state.extractedFiles)) {
    rows.push(
      upsertExtractionStem({
        projectId: asset.projectId,
        assetId: asset.id,
        stemId,
        path,
        detectedKey: state.detectedKey
      })
    )
  }
  return rows
}
