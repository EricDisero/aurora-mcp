// Port of aurora/src/main/storage/assets.ts — identical kind subfolders, asset
// rows, stems-dir naming, and delete semantics.

import { join, basename, extname } from 'node:path'
import { mkdir, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import { getProjectDirectory, slugify, touchProject } from './projects.js'
import { addReference, deleteReference } from './references.js'
import type { AssetKind, ProjectAsset } from '../types.js'

const KIND_DIRS: Record<AssetKind, string> = {
  generation: 'generations',
  cover: 'covers',
  import: 'imports',
  reference: 'references',
  master: 'masters'
}

interface AssetRow {
  id: string
  project_id: string
  kind: AssetKind
  name: string
  path: string
  origin: string | null
  source_asset_id: string | null
  ref_id: string | null
  created_at: number
}

function rowToAsset(row: AssetRow): ProjectAsset {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    name: row.name,
    path: row.path,
    origin: row.origin ? (JSON.parse(row.origin) as Record<string, unknown>) : null,
    sourceAssetId: row.source_asset_id,
    refId: row.ref_id,
    createdAt: row.created_at
  }
}

export function listAssets(projectId: string): ProjectAsset[] {
  const rows = getDb()
    .prepare('SELECT * FROM project_assets WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as AssetRow[]
  return rows.map(rowToAsset)
}

export function getAsset(id: string): ProjectAsset | null {
  const row = getDb().prepare('SELECT * FROM project_assets WHERE id = ?').get(id) as
    | AssetRow
    | undefined
  return row ? rowToAsset(row) : null
}

/** The kind subfolder inside the project dir, created on demand. */
export async function ensureKindDir(projectId: string, kind: AssetKind): Promise<string> {
  const dir = join(getProjectDirectory(projectId), KIND_DIRS[kind])
  await mkdir(dir, { recursive: true })
  return dir
}

/** Where an asset's split stems land: <project>/stems/<asset-slug>-<shortid>/. */
export function getAssetStemsDir(asset: ProjectAsset): string {
  return join(
    getProjectDirectory(asset.projectId),
    'stems',
    `${slugify(asset.name, 40)}-${asset.id.slice(0, 6)}`
  )
}

/** Where an asset's Sample Extractor results land:
 *  <project>/extracts/<asset-slug>-<shortid>/. Same naming discipline as stems. */
export function getAssetExtractsDir(asset: ProjectAsset): string {
  return join(
    getProjectDirectory(asset.projectId),
    'extracts',
    `${slugify(asset.name, 40)}-${asset.id.slice(0, 6)}`
  )
}

/** Non-clobbering destination filename inside a kind dir. */
export function uniqueDestPath(dir: string, fileName: string): string {
  const ext = extname(fileName)
  const stem = basename(fileName, ext)
  let candidate = join(dir, fileName)
  for (let i = 2; existsSync(candidate); i++) {
    candidate = join(dir, `${stem}-${i}${ext}`)
  }
  return candidate
}

export function insertAsset(params: {
  projectId: string
  kind: AssetKind
  name: string
  path: string
  origin?: unknown
  sourceAssetId?: string | null
  refId?: string | null
}): ProjectAsset {
  const id = uuidv4()
  getDb()
    .prepare(
      `INSERT INTO project_assets (id, project_id, kind, name, path, origin, source_asset_id, ref_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      params.projectId,
      params.kind,
      params.name,
      params.path,
      params.origin ? JSON.stringify(params.origin) : null,
      params.sourceAssetId ?? null,
      params.refId ?? null,
      Date.now()
    )
  touchProject(params.projectId)
  return getAsset(id)!
}

/** Copy an external file into the project as an import or reference asset.
 *  References ALSO get a reference_tracks row (the global curve cache). */
export async function addFileAsset(params: {
  projectId: string
  kind: 'import' | 'reference'
  filePath: string
}): Promise<ProjectAsset> {
  const dir = await ensureKindDir(params.projectId, params.kind)
  const dest = uniqueDestPath(dir, basename(params.filePath))
  await copyFile(params.filePath, dest)

  const name = basename(dest, extname(dest))
  let refId: string | null = null
  if (params.kind === 'reference') {
    const ref = await addReference(dest, { copy: false })
    refId = ref.id
  }

  return insertAsset({ projectId: params.projectId, kind: params.kind, name, path: dest, refId })
}

/** Point an asset at a new file (e.g. after a WAV fetch upgrades the MP3). */
export function updateAssetPath(id: string, path: string): ProjectAsset {
  getDb().prepare('UPDATE project_assets SET path = ? WHERE id = ?').run(path, id)
  return getAsset(id)!
}

/** Delete an asset: row, stems rows, its audio file, its stems folder, and its
 *  linked reference row if any. */
export async function deleteAsset(id: string): Promise<void> {
  const asset = getAsset(id)
  if (!asset) return

  const db = getDb()
  db.prepare('DELETE FROM project_stems WHERE asset_id = ?').run(id)
  db.prepare('DELETE FROM extraction_stems WHERE asset_id = ?').run(id)
  db.prepare('DELETE FROM project_assets WHERE id = ?').run(id)

  await rm(asset.path, { force: true }).catch(() => {})
  await rm(getAssetStemsDir(asset), { recursive: true, force: true }).catch(() => {})
  await rm(getAssetExtractsDir(asset), { recursive: true, force: true }).catch(() => {})
  if (asset.refId) await deleteReference(asset.refId).catch(() => {})
  touchProject(asset.projectId)
}
