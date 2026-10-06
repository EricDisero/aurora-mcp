// Progressive split: canonical checked routes, then local float-WAV phase cancellation.
import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { MvsepError } from './providers/mvsep.js'
import { SPLIT_ROUTES } from './separation/routes.js'
import { submitRoute, landRouteResult, type RouteRun, type SubmittedRoute } from './separation/run-route.js'
import type { SeparationProvider, SeparationResult } from './separation/contracts.js'
import { getAsset, getAssetStemsDir } from './storage/assets.js'
import { getStems, upsertStem } from './storage/stems.js'
import { standardizeToWav } from './audio/ffmpeg.js'
import { decodeWavFile, encodeWavFloat32File, subtractWavs } from './audio/wav.js'
import type { ProjectAsset, ProjectStem, StemType } from './types.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
export type SplitJobName = keyof typeof SPLIT_ROUTES

export interface SplitPreparation {
  asset: ProjectAsset
  stemsDir: string
  originalPath: string
  audioBytes: Buffer
}

export async function prepareSplit(assetId: string): Promise<SplitPreparation> {
  const asset = getAsset(assetId)
  if (!asset) throw new Error(`Asset not found: ${assetId}`)
  if (!existsSync(asset.path)) throw new Error(`Asset audio file is missing on disk: ${asset.path}`)
  const stemsDir = getAssetStemsDir(asset)
  await mkdir(stemsDir, { recursive: true })
  const originalPath = join(stemsDir, 'original.wav')
  await standardizeToWav(asset.path, originalPath)
  return { asset, stemsDir, originalPath, audioBytes: await readFile(originalPath) }
}

/** The provider must persist uploadName/spec BEFORE forwarding createJob; onSubmitted saves the hash.
 * Prefer startSplitJob + advanceJob. Calling the old untracked form fails before spending. */
export async function createSplitJobs(
  audioBytes: Buffer,
  provider?: SeparationProvider,
  onSubmitted?: (job: SplitJobName, submitted: SubmittedRoute) => Promise<void>
): Promise<Record<SplitJobName, string>> {
  if (!provider || !onSubmitted) throw new MvsepError('JOB_MANIFEST_REQUIRED',
    'A durable planned manifest is required before submitting split jobs.', false,
    'Use startSplitJob(assetId), then advanceJob(manifest).', 'queued')
  const hashes = {} as Record<SplitJobName, string>
  for (const job of Object.keys(SPLIT_ROUTES) as SplitJobName[]) {
    if (Object.keys(hashes).length > 0) await sleep(2000)
    const submitted = await submitRoute(provider, { route: SPLIT_ROUTES[job], input: audioBytes })
    hashes[job] = submitted.hash
    await onSubmitted(job, submitted)
  }
  return hashes
}

/** Land only after exact identity and content checks pass. Retain the drums bus for Other and recovery. */
export async function landSplitJob(
  job: SplitJobName,
  result: SeparationResult,
  asset: ProjectAsset,
  stemsDir: string,
  hash: string = 'unknown',
  onChecked?: (run: RouteRun) => Promise<void>,
  inputBytes?: Buffer
): Promise<ProjectStem[]> {
  const run = await landRouteResult(hash, result, {
    route: SPLIT_ROUTES[job], input: inputBytes ?? await readFile(join(stemsDir, 'original.wav')), destDir: stemsDir,
    fileNames: { drums_bus: 'drums-bus.wav' }
  })
  await onChecked?.(run)
  const rows: ProjectStem[] = []
  for (const [stemType, path] of Object.entries(run.stems)) {
    if (stemType === 'drums_bus') continue
    rows.push(upsertStem({ projectId: asset.projectId, assetId: asset.id,
      stemType: stemType as StemType, path, origin: 'mvsep' }))
  }
  if (job === 'drumsep') {
    const [bus, kick, snare, toms] = await Promise.all(
      ['drums-bus', 'kick', 'snare', 'toms'].map((name) => decodeWavFile(join(stemsDir, `${name}.wav`)))
    )
    const hats = subtractWavs(bus, kick, snare, toms)
    const path = join(stemsDir, 'hats.wav')
    await encodeWavFloat32File(path, hats.channels, hats.sampleRate)
    rows.push(upsertStem({ projectId: asset.projectId, assetId: asset.id,
      stemType: 'hats', path, origin: 'synthesized' }))
  }
  return rows
}

export async function finalizeSplit(asset: ProjectAsset, stemsDir: string): Promise<ProjectStem> {
  const [original, vocals, drums, bass] = await Promise.all(
    ['original', 'vocals', 'drums-bus', 'bass'].map((name) => decodeWavFile(join(stemsDir, `${name}.wav`)))
  )
  const other = subtractWavs(original, vocals, drums, bass)
  const path = join(stemsDir, 'other.wav')
  await encodeWavFloat32File(path, other.channels, other.sampleRate)
  return upsertStem({ projectId: asset.projectId, assetId: asset.id, stemType: 'other', path, origin: 'synthesized' })
}

/** Same durable path as background work; sibling routes settle before a partial failure is reported. */
export async function runSplitBlocking(
  assetId: string, onProgress?: (stage: string) => void
): Promise<ProjectStem[]> {
  const { startSplitJob, advanceJob, isJobActive } = await import('./jobs.js')
  let manifest = await startSplitJob(assetId)
  const deadline = Date.now() + 12 * 60 * 1000
  while (isJobActive(manifest) && Date.now() < deadline) {
    manifest = await advanceJob(manifest)
    onProgress?.(manifest.stage)
    if (isJobActive(manifest)) await sleep(5000)
  }
  if (manifest.status !== 'completed') {
    throw new MvsepError(isJobActive(manifest) ? 'MVSEP_NETWORK' : 'MVSEP_JOB_FAILED',
      `Split job ${manifest.jobId}: ${manifest.stage}`, isJobActive(manifest),
      `Inspect or advance job ${manifest.jobId}; its hashes and any landed stems are preserved.`, manifest.stage)
  }
  return getStems(assetId)
}
