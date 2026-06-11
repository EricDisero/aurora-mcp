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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createSeparationJob } from './providers/mvsep.js'
import { getAsset, getAssetExtractsDir } from './storage/assets.js'
import { upsertExtractionStem } from './storage/extractions.js'
import { probeDurationSeconds, standardizeToWav } from './audio/ffmpeg.js'
import { decodeWavFile, encodeWavFloat32File, subtractWavs } from './audio/wav.js'
import { detectKey } from './key-detect.js'
import {
  EXTRACT_MAX_DURATION_SECONDS,
  identifyOutputFiles,
  planApiCalls,
  type ExtractSelection,
  type PlannedApiCall
} from './extract-catalog.js'
import type { ExtractionStem, MvsepJobSpec, ProjectAsset, SeparationResultFile } from './types.js'

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
}

function specFor(call: PlannedApiCall): MvsepJobSpec {
  const spec: MvsepJobSpec = {
    sep_type: String(call.sepType),
    output_format: '4', // 32-bit float WAV — phase accuracy for EE
    is_demo: '0'
  }
  if (call.addOpt1 !== undefined) spec.add_opt1 = String(call.addOpt1)
  if (call.addOpt2 !== undefined) spec.add_opt2 = String(call.addOpt2)
  return spec
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
      failures: []
    }
  }
}

/** Submit the next planned call. Mutates state (currentHash). */
export async function submitNextExtractCall(state: ExtractJobState): Promise<void> {
  const call = state.calls[state.callIndex]
  const inputPath =
    call.inputSource === 'dry' && state.vocalDryPath ? state.vocalDryPath : state.originalPath
  const audio = await readFile(inputPath)
  const { hash } = await createSeparationJob(audio, specFor(call))
  state.currentHash = hash
}

/** Land a finished call's files. Mutates state (extractedFiles / vocalDryPath),
 *  then advances callIndex and clears the hash. */
export async function landExtractCall(
  state: ExtractJobState,
  files: SeparationResultFile[]
): Promise<void> {
  const call = state.calls[state.callIndex]
  const outputs = identifyOutputFiles(files, call.outputType)

  for (const [stemKey, url] of Object.entries(outputs)) {
    const dest = join(state.extractDir, `${stemKey}.wav`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Stem download failed (HTTP ${res.status}): ${url}`)
    await writeFile(dest, Buffer.from(await res.arrayBuffer()))

    if (call.type === 'dereverb') {
      if (stemKey === 'vocal_dry') {
        state.vocalDryPath = dest
        // Deliver vocal_dry only in reverb-only mode (no vocal bundle).
        if (call.deliverVocalDry) state.extractedFiles.vocal_dry = dest
      } else if (stemKey === 'vocal_reverb') {
        state.extractedFiles.vocal_reverb = dest
      }
    } else {
      state.extractedFiles[stemKey] = dest
    }
  }

  state.callIndex++
  state.currentHash = null
}

/** Record a failed call and move on (prism behavior: partial results survive). */
export function failExtractCall(state: ExtractJobState, message: string): void {
  const call = state.calls[state.callIndex]
  state.failures.push(`${call?.outputType ?? 'call'}: ${message}`)
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
    Object.values(state.extractedFiles).map((path) => decodeWavFile(path))
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
