import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, normalize, resolve, sep } from 'node:path'
import { getDb } from '../db.js'
import { getAsset } from '../storage/assets.js'
import { createStemSet, listStoredSets } from '../storage/stem-sets.js'
import { STEM_LABELS } from '../types.js'
import type { ImportSplitJobRequest, ImportSplitJobResult, StemType } from '../types.js'

// Port of aurora/src/main/ingest/split-job.ts.
interface JobOutput {
  label: string
  path: string
}

function comparablePath(path: string): string {
  const normalized = normalize(path.replace(/[\\/]/g, sep))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export async function importSplitJob(params: ImportSplitJobRequest): Promise<ImportSplitJobResult> {
  if (!params.jobJsonPath?.trim()) throw new Error('A split job.json path is required.')
  const sourcePath = resolve(params.jobJsonPath)
  let manifest: {
    command?: string
    status?: string
    args?: { input?: string }
    outputs?: JobOutput[]
  }
  try {
    manifest = JSON.parse(await readFile(sourcePath, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read split job manifest ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!manifest || manifest.command !== 'split') throw new Error('Job manifest command must be split.')
  // The bridge writes "ok"; callers may also provide the explicit "done" status.
  if (manifest.status !== 'ok' && manifest.status !== 'done') {
    throw new Error(`Split job is not done (status: ${manifest.status ?? 'missing'}).`)
  }
  if (!Array.isArray(manifest.outputs) || !manifest.outputs.length) {
    throw new Error('Split job has no outputs.')
  }
  for (const output of manifest.outputs) {
    if (!output || typeof output.label !== 'string' || typeof output.path !== 'string') {
      throw new Error('Split job outputs must contain a label and file path.')
    }
    if (!isAbsolute(output.path)) throw new Error(`Split output path must be absolute: ${output.path}`)
    if (!existsSync(output.path) || !statSync(output.path).isFile()) {
      throw new Error(`Split output file not found: ${output.path}`)
    }
  }

  const outputs = new Map<string, JobOutput>()
  const skipped: ImportSplitJobResult['skipped'] = []
  const hasEe = manifest.outputs.some((output) => output.label === 'ee')
  const canonical: StemType[] = ['vocals', 'bass', 'kick', 'snare', 'hats', 'toms', 'other']
  for (const output of manifest.outputs) {
    let reason: string | undefined
    if (output.label === 'other' && hasEe) {
      reason = 'Legacy non-bass intermediate overlaps vocals and drums; ee is the real leftover.'
    } else if (output.label === 'original') {
      reason = 'Original audio overlaps every canonical lane.'
    } else if (output.label === 'instrumental') {
      reason = 'Instrumental overlaps the canonical instrument lanes.'
    } else if (output.label === 'crash' || output.label === 'ride') {
      reason = 'Cymbals are already included in hats.'
    } else if (output.label !== 'ee' && !canonical.includes(output.label as StemType)) {
      reason = 'Not a canonical split stem.'
    }
    if (reason) {
      skipped.push({ ...output, reason })
      continue
    }
    const key = output.label === 'ee' ? 'other' : output.label
    if (outputs.has(key)) throw new Error(`Split job has duplicate output: ${key}`)
    outputs.set(key, output)
  }
  const lanes = canonical.map((stemKey) => {
    const output = outputs.get(stemKey)
    if (!output) throw new Error(`Split job is missing canonical output: ${stemKey}`)
    return { stemKey, label: STEM_LABELS[stemKey], path: output.path }
  })

  const db = getDb()
  return db.transaction(() => {
    let assetId = params.assetId
    if (!assetId) {
      const input = manifest.args?.input
      if (typeof input !== 'string' || !input) throw new Error('Split job is missing its input path.')
      const assets = db.prepare('SELECT id, path FROM project_assets ORDER BY created_at, rowid')
        .all() as { id: string; path: string }[]
      assetId = assets.find((asset) => comparablePath(asset.path) === comparablePath(input))?.id
      if (!assetId) throw new Error(`No project asset matches split input: ${input}`)
    }
    const asset = getAsset(assetId)
    if (!asset) throw new Error(`Asset not found: ${assetId}`)
    const existing = listStoredSets(assetId).find((set) => set.sourcePath !== null
      && comparablePath(set.sourcePath) === comparablePath(sourcePath))
    if (existing) return { set: existing, reused: true, skipped }
    const set = createStemSet({
      projectId: asset.projectId,
      assetId,
      kind: 'import',
      name: params.name?.trim() || basename(dirname(sourcePath)),
      sourcePath,
      lanes
    })
    return { set, reused: false, skipped }
  }).immediate()
}
