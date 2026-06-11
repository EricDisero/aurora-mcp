// 3-job MVSEP split orchestration — port of aurora/src/main/split/orchestrate.ts
// (real-call verified 2026-06-10), restructured for PER-STEM PROGRESSIVE
// LANDING: each MVSEP job's stems register the moment that job finishes instead
// of gating on all three. Dependency graph:
//   vocals job (40)  → vocals
//   drumsep job (37) → kick, snare, toms, + hats (= drums − kick − snare − toms)
//   bass job (41)    → bass
//   ee               → needs ALL THREE (original − vocals − drums − bass)
// Contract: aurora/docs/build-specs/mvsep-separation-contract.md.

import { join } from 'node:path'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { awaitSeparationResult, createSeparationJob } from './providers/mvsep.js'
import { getAsset, getAssetStemsDir } from './storage/assets.js'
import { upsertStem } from './storage/stems.js'
import { standardizeToWav } from './audio/ffmpeg.js'
import { decodeWavFile, encodeWavFloat32File, subtractWavs } from './audio/wav.js'
import type { MvsepJobSpec, ProjectAsset, ProjectStem, SeparationResultFile } from './types.js'

const CONCURRENT_DELAY_MS = 2000 // contract CONCURRENT_DELAY=2
const OUTPUT_FORMAT_WAV32 = '4'
const IS_DEMO = '0'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type SplitJobName = 'vocals' | 'drumsep' | 'bass'

// The 3 CREATE jobs (contract Part A; re-verified vs live algorithms 2026-06-10).
export const JOB_SPECS: Record<SplitJobName, MvsepJobSpec> = {
  // BS Roformer ver 2025.07 → vocals + instrumental.
  vocals: { sep_type: '40', output_format: OUTPUT_FORMAT_WAV32, is_demo: IS_DEMO, add_opt1: '81' },
  // DrumSep MelBand Roformer 6-stem. add_opt1=7 is MANDATORY.
  drumsep: { sep_type: '37', output_format: OUTPUT_FORMAT_WAV32, is_demo: IS_DEMO, add_opt1: '7', add_opt2: '0' },
  // MVSep Bass, BS Roformer SW + SCNet XL → bass + other.
  bass: { sep_type: '41', output_format: OUTPUT_FORMAT_WAV32, is_demo: IS_DEMO, add_opt1: '5', add_opt2: '0' }
}

/** Find a file by lowercased-filename predicate, else throw a clear error. */
function pickFile(files: SeparationResultFile[], match: (lowerName: string) => boolean): string {
  const hit = files.find((f) => match(f.filename.toLowerCase()) || match(f.url.toLowerCase()))
  if (!hit) {
    throw new Error(
      `Could not locate expected stem in MVSEP result. Files: ${files.map((f) => f.filename).join(', ')}`
    )
  }
  return hit.url
}

async function downloadTo(url: string, destPath: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Stem download failed (HTTP ${res.status}): ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(destPath, buf)
}

export interface SplitPreparation {
  asset: ProjectAsset
  stemsDir: string
  originalPath: string
  audioBytes: Buffer
}

/** Step 0: resolve the asset + standardize its audio (the single preprocessed
 *  file all 3 jobs AND the ee reference use). */
export async function prepareSplit(assetId: string): Promise<SplitPreparation> {
  const asset = getAsset(assetId)
  if (!asset) throw new Error(`Asset not found: ${assetId}`)
  if (!existsSync(asset.path)) {
    throw new Error(`Asset audio file is missing on disk: ${asset.path}`)
  }

  const stemsDir = getAssetStemsDir(asset)
  await mkdir(stemsDir, { recursive: true })

  const originalPath = join(stemsDir, 'original.wav')
  await standardizeToWav(asset.path, originalPath)
  const audioBytes = await readFile(originalPath)
  return { asset, stemsDir, originalPath, audioBytes }
}

/** Step 1: fire the 3 CREATE jobs with the contract's 2s stagger. Returns the
 *  provider hashes (persist these — they survive process restarts). */
export async function createSplitJobs(
  audioBytes: Buffer
): Promise<Record<SplitJobName, string>> {
  const vocals = await createSeparationJob(audioBytes, JOB_SPECS.vocals)
  await sleep(CONCURRENT_DELAY_MS)
  const drumsep = await createSeparationJob(audioBytes, JOB_SPECS.drumsep)
  await sleep(CONCURRENT_DELAY_MS)
  const bass = await createSeparationJob(audioBytes, JOB_SPECS.bass)
  return { vocals: vocals.hash, drumsep: drumsep.hash, bass: bass.hash }
}

/** Land ONE finished job's stems (progressive). Returns the stem rows created.
 *  Idempotent per job — re-running re-downloads and upserts in place. */
export async function landSplitJob(
  job: SplitJobName,
  files: SeparationResultFile[],
  asset: ProjectAsset,
  stemsDir: string
): Promise<ProjectStem[]> {
  const { projectId } = asset
  const rows: ProjectStem[] = []

  if (job === 'vocals') {
    const url = pickFile(files, (n) => /vocal/.test(n) && !/no_vocal|instrumental/.test(n))
    const dest = join(stemsDir, 'vocals.wav')
    await downloadTo(url, dest)
    rows.push(upsertStem({ projectId, assetId: asset.id, stemType: 'vocals', path: dest, origin: 'mvsep' }))
    return rows
  }

  if (job === 'bass') {
    const url = pickFile(files, (n) => /bass/.test(n) && !/no_bass|other/.test(n))
    const dest = join(stemsDir, 'bass.wav')
    await downloadTo(url, dest)
    rows.push(upsertStem({ projectId, assetId: asset.id, stemType: 'bass', path: dest, origin: 'mvsep' }))
    return rows
  }

  // drumsep: kick, snare, toms + the full drums bus → hats by phase cancel.
  const kickFile = join(stemsDir, 'kick.wav')
  const snareFile = join(stemsDir, 'snare.wav')
  const tomsFile = join(stemsDir, 'toms.wav')
  const drumsBusFile = join(stemsDir, 'drums-bus.wav')

  await Promise.all([
    downloadTo(pickFile(files, (n) => /kick/.test(n)), kickFile),
    downloadTo(pickFile(files, (n) => /snare/.test(n)), snareFile),
    downloadTo(pickFile(files, (n) => /tom/.test(n)), tomsFile),
    downloadTo(pickFile(files, (n) => /drums\.wav/.test(n)), drumsBusFile)
  ])

  rows.push(upsertStem({ projectId, assetId: asset.id, stemType: 'kick', path: kickFile, origin: 'mvsep' }))
  rows.push(upsertStem({ projectId, assetId: asset.id, stemType: 'snare', path: snareFile, origin: 'mvsep' }))
  rows.push(upsertStem({ projectId, assetId: asset.id, stemType: 'toms', path: tomsFile, origin: 'mvsep' }))

  // hats = drums − kick − snare − toms (only needs this job's files).
  const [drumsBus, kick, snare, toms] = await Promise.all([
    decodeWavFile(drumsBusFile),
    decodeWavFile(kickFile),
    decodeWavFile(snareFile),
    decodeWavFile(tomsFile)
  ])
  const hats = subtractWavs(drumsBus, kick, snare, toms)
  const hatsFile = join(stemsDir, 'hats.wav')
  await encodeWavFloat32File(hatsFile, hats.channels, hats.sampleRate)
  rows.push(upsertStem({ projectId, assetId: asset.id, stemType: 'hats', path: hatsFile, origin: 'synthesized' }))

  return rows
}

/** Final step once ALL THREE jobs have landed: synthesize ee
 *  (original − vocals − drums-bus − bass), then drop the drums-bus intermediate. */
export async function finalizeSplit(asset: ProjectAsset, stemsDir: string): Promise<ProjectStem> {
  const originalPath = join(stemsDir, 'original.wav')
  const drumsBusFile = join(stemsDir, 'drums-bus.wav')

  const [original, vocals, drumsBus, bass] = await Promise.all([
    decodeWavFile(originalPath),
    decodeWavFile(join(stemsDir, 'vocals.wav')),
    decodeWavFile(drumsBusFile),
    decodeWavFile(join(stemsDir, 'bass.wav'))
  ])

  const ee = subtractWavs(original, vocals, drumsBus, bass)
  const eeFile = join(stemsDir, 'ee.wav')
  await encodeWavFloat32File(eeFile, ee.channels, ee.sampleRate)

  const row = upsertStem({
    projectId: asset.projectId,
    assetId: asset.id,
    stemType: 'ee',
    path: eeFile,
    origin: 'synthesized'
  })

  await unlink(drumsBusFile).catch(() => {})
  return row
}

/** Blocking end-to-end split with progressive landing — each job's stems
 *  register as that job finishes. Returns all 7 stem rows. */
export async function runSplitBlocking(
  assetId: string,
  onProgress?: (stage: string) => void
): Promise<ProjectStem[]> {
  onProgress?.('Standardizing audio')
  const prep = await prepareSplit(assetId)

  onProgress?.('Submitting 3 MVSEP jobs')
  const hashes = await createSplitJobs(prep.audioBytes)

  const rows: ProjectStem[] = []
  const land = async (job: SplitJobName): Promise<void> => {
    const files = await awaitSeparationResult({ hash: hashes[job] }, (s) => onProgress?.(`${job}: ${s}`))
    onProgress?.(`${job}: downloading stems`)
    rows.push(...(await landSplitJob(job, files, prep.asset, prep.stemsDir)))
    onProgress?.(`${job}: landed`)
  }

  await Promise.all([land('vocals'), land('drumsep'), land('bass')])

  onProgress?.('Synthesizing everything-else (ee)')
  rows.push(await finalizeSplit(prep.asset, prep.stemsDir))
  onProgress?.('Split complete')
  return rows
}
