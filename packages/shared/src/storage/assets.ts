// Port of aurora/src/main/storage/assets.ts — identical kind subfolders, asset
// rows, stems-dir naming, and delete semantics.

import { join, basename, dirname, extname, relative, isAbsolute } from 'node:path'
import { mkdir, rm, copyFile, rename, rmdir } from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import { getProjectDirectory, slugify, touchProject } from './projects.js'
import { getTrackDirectory } from './tracks.js'
import { deleteReference } from './references.js'
import { deleteSetsForAsset } from './stem-sets.js'
import { rewriteStemPaths } from './moved-paths.js'
import type { AssetKind, ProjectAsset } from '../types.js'
import { deriveAssetRecipe, parseRecipe, localRecipe, type Recipe } from '../recipe.js'
import { standardizeToWav } from '../audio/ffmpeg.js'

const KIND_DIRS: Record<AssetKind, string> = {
  generation: 'generations',
  cover: 'covers',
  track: 'tracks',
  master: 'masters'
}

interface AssetRow {
  id: string
  project_id: string
  track_id: string | null
  kind: AssetKind
  name: string
  path: string
  origin: string | null
  source_asset_id: string | null
  ref_id: string | null
  favorite: number
  created_at: number
  recipe: string | null
}

function rowToAsset(row: AssetRow): ProjectAsset {
  return {
    id: row.id,
    projectId: row.project_id,
    trackId: row.track_id,
    kind: row.kind,
    name: row.name,
    path: row.path,
    origin: row.origin ? (JSON.parse(row.origin) as Record<string, unknown>) : null,
    sourceAssetId: row.source_asset_id,
    refId: row.ref_id,
    favorite: !!row.favorite,
    createdAt: row.created_at,
    recipe:
      parseRecipe(row.recipe) ??
      deriveAssetRecipe({ kind: row.kind, origin: row.origin, sourceAssetId: row.source_asset_id, refId: row.ref_id, createdAt: row.created_at })
  }
}

/** The base dir an asset's files live under: the track subfolder if filed to a
 *  track, else the project root (unfiled / legacy layout). */
function getAssetBaseDir(projectId: string, trackId: string | null | undefined): string {
  return trackId ? getTrackDirectory(trackId, projectId) : getProjectDirectory(projectId)
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

/** The kind subfolder where a new asset's file lands, created on demand. Pass
 *  trackId to nest it under a track subfolder; omit for the project root. */
export async function ensureKindDir(
  projectId: string,
  kind: AssetKind,
  trackId?: string | null
): Promise<string> {
  const dir = join(getAssetBaseDir(projectId, trackId), KIND_DIRS[kind])
  await mkdir(dir, { recursive: true })
  return dir
}

/** Where an asset's split stems land: <base>/stems/<asset-slug>-<shortid>/,
 *  where <base> is the asset's track subfolder if filed, else the project root. */
export function getAssetStemsDir(asset: ProjectAsset): string {
  return join(
    getAssetBaseDir(asset.projectId, asset.trackId),
    'stems',
    `${slugify(asset.name, 40)}-${asset.id.slice(0, 6)}`
  )
}

/** Where an asset's Sample Extractor results land:
 *  <base>/extracts/<asset-slug>-<shortid>/. Same naming discipline as stems. */
export function getAssetExtractsDir(asset: ProjectAsset): string {
  return join(
    getAssetBaseDir(asset.projectId, asset.trackId),
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
  trackId?: string | null
  kind: AssetKind
  name: string
  path: string
  origin?: unknown
  sourceAssetId?: string | null
  refId?: string | null
  /** What made it. Absent: derived from origin and lineage, with `missing` saying what is not known. */
  recipe?: Recipe | null
}): ProjectAsset {
  const id = uuidv4()
  const createdAt = Date.now()
  const recipe =
    params.recipe ??
    deriveAssetRecipe({ kind: params.kind, origin: params.origin ?? null, sourceAssetId: params.sourceAssetId ?? null, createdAt })
  getDb()
    .prepare(
      `INSERT INTO project_assets (id, project_id, track_id, kind, name, path, origin, source_asset_id, ref_id, favorite, created_at, recipe)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(
      id,
      params.projectId,
      params.trackId ?? null,
      params.kind,
      params.name,
      params.path,
      params.origin ? JSON.stringify(params.origin) : null,
      params.sourceAssetId ?? null,
      params.refId ?? null,
      createdAt,
      JSON.stringify(recipe)
    )
  touchProject(params.projectId)
  return getAsset(id)!
}

/** Standardize an external file into the project as a neutral 'track' asset. The curve
 *  cache (reference_tracks) is born lazily only when this track is later pointed
 *  at as a match target — not at add time. */
export async function addFileAsset(params: {
  projectId: string
  trackId?: string | null
  filePath: string
  /** A local transform landing through here names its own source and recipe. */
  sourceAssetId?: string | null
  recipe?: Recipe | null
}): Promise<ProjectAsset> {
  const dir = await ensureKindDir(params.projectId, 'track', params.trackId)
  const dest = uniqueDestPath(dir, `${basename(params.filePath, extname(params.filePath))}.wav`)
  await standardizeToWav(params.filePath, dest)

  return insertAsset({
    projectId: params.projectId,
    trackId: params.trackId,
    kind: 'track',
    name: basename(dest, extname(dest)),
    path: dest,
    sourceAssetId: params.sourceAssetId ?? null,
    recipe: params.recipe ?? localRecipe({ operation: 'import', recordedBy: 'mcp',
      inputs: [{ role: 'upload', path: params.filePath, name: basename(params.filePath) }],
      settings: { standardizedTo: 'wav 44.1 kHz stereo float32' } })
  })
}

/** Link an asset to a reference_tracks row (the curve cache the mastering flow
 *  keys off). Mirrors the app's setAssetRefId. */
export function setAssetRefId(id: string, refId: string): ProjectAsset {
  getDb().prepare('UPDATE project_assets SET ref_id = ? WHERE id = ?').run(refId, id)
  return getAsset(id)!
}

/** Point an asset at a new file (e.g. after a WAV fetch upgrades the MP3). */
export function updateAssetPath(id: string, path: string): ProjectAsset {
  getDb().prepare('UPDATE project_assets SET path = ? WHERE id = ?').run(path, id)
  return getAsset(id)!
}

/** Set an asset's persisted favorite flag. */
export function setAssetFavorite(id: string, favorite: boolean): ProjectAsset {
  getDb().prepare('UPDATE project_assets SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, id)
  return getAsset(id)!
}

/** rename across the same volume; fall back to copy+unlink across devices. */
async function moveFile(src: string, dest: string): Promise<void> {
  if (existsSync(dest)) throw new Error(`Move destination already exists: ${dest}`)
  try {
    await rename(src, dest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await copyFile(src, dest, constants.COPYFILE_EXCL)
    await rm(src)
  }
}

async function moveAssetSubdir(oldDir: string, newDir: string, paths: string[]): Promise<Array<[string, string]>> {
  if (!paths.length || !existsSync(oldDir)) return []
  const moves: Array<[string, string]> = []
  await mkdir(newDir, { recursive: true })
  for (const oldPath of new Set(paths)) {
    const dest = movedSubdirPath(oldDir, newDir, oldPath)
    if (existsSync(oldPath)) {
      await mkdir(dirname(dest), { recursive: true })
      await moveFile(oldPath, dest)
      moves.push([oldPath, dest])
    }
  }
  // Unregistered files stay here for deleteTrack to preserve later.
  await rmdir(oldDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
  })
  return moves
}

function livesUnder(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')
}

function movedSubdirPath(oldDir: string, newDir: string, path: string): string {
  return join(newDir, livesUnder(oldDir, path) ? relative(oldDir, path) : basename(path))
}

/** Re-file an asset to a track (or null = unfiled). Physically relocates the
 *  asset's audio file plus its stems/ and extracts/ folders to match the new
 *  track, and rewrites every stored path. No-op if already there. */
export async function setAssetTrack(id: string, trackId: string | null): Promise<ProjectAsset> {
  const asset = getAsset(id)
  if (!asset) throw new Error(`asset not found: ${id}`)
  const current = asset.trackId ?? null
  const target = trackId ?? null
  if (current === target) return asset

  const db = getDb()

  const newKindDir = await ensureKindDir(asset.projectId, asset.kind, target)
  const newPath = uniqueDestPath(newKindDir, basename(asset.path))
  if (existsSync(asset.path)) await moveFile(asset.path, newPath)

  const oldStemsDir = getAssetStemsDir(asset)
  const oldExtractsDir = getAssetExtractsDir(asset)
  const moved: ProjectAsset = { ...asset, trackId: target }
  const newStemsDir = getAssetStemsDir(moved)
  const newExtractsDir = getAssetExtractsDir(moved)

  const storedLanes = db.prepare('SELECT id, path FROM stem_lanes').all() as Array<{ id: string; path: string }>
  const storedStems = storedLanes.filter((r) => livesUnder(oldStemsDir, r.path))
  const storedExtracts = storedLanes.filter((r) => livesUnder(oldExtractsDir, r.path))

  const stemRows = db
    .prepare('SELECT id, path FROM project_stems WHERE asset_id = ?')
    .all(id) as Array<{ id: string; path: string }>
  const stemMoves = await moveAssetSubdir(oldStemsDir, newStemsDir, [...stemRows, ...storedStems].map((r) => r.path))

  const extractRows = db
    .prepare('SELECT id, path FROM extraction_stems WHERE asset_id = ?')
    .all(id) as Array<{ id: string; path: string }>
  const extractMoves = await moveAssetSubdir(oldExtractsDir, newExtractsDir, [...extractRows, ...storedExtracts].map((r) => r.path))

  // A linked reference_tracks row (copy:false — its audio_path IS the asset's
  // file) must follow the move too, or analyze breaks after re-filing.
  const setStem = db.prepare('UPDATE project_stems SET path = ? WHERE id = ?')
  const setExtract = db.prepare('UPDATE extraction_stems SET path = ? WHERE id = ?')
  db.transaction(() => {
    db.prepare('UPDATE project_assets SET track_id = ?, path = ? WHERE id = ?').run(
      target,
      newPath,
      id
    )
    if (asset.refId) {
      db.prepare('UPDATE reference_tracks SET audio_path = ? WHERE id = ? AND audio_path = ?').run(
        newPath,
        asset.refId,
        asset.path
      )
    }
    for (const r of stemRows) setStem.run(movedSubdirPath(oldStemsDir, newStemsDir, r.path), r.id)
    for (const r of extractRows) setExtract.run(movedSubdirPath(oldExtractsDir, newExtractsDir, r.path), r.id)
    rewriteStemPaths([[asset.path, newPath], ...stemMoves, ...extractMoves])
  })()

  touchProject(asset.projectId)
  return getAsset(id)!
}

/** Delete an asset: row, stems rows, its audio file, its stems folder, and its
 *  linked reference row if any. */
export async function deleteAsset(id: string): Promise<void> {
  const asset = getAsset(id)
  if (!asset) return

  const db = getDb()
  db.transaction(() => {
    deleteSetsForAsset(id)
    db.prepare('DELETE FROM project_stems WHERE asset_id = ?').run(id)
    db.prepare('DELETE FROM extraction_stems WHERE asset_id = ?').run(id)
    db.prepare('DELETE FROM project_assets WHERE id = ?').run(id)
  })()

  await rm(asset.path, { force: true }).catch(() => {})
  await rm(getAssetStemsDir(asset), { recursive: true, force: true }).catch(() => {})
  await rm(getAssetExtractsDir(asset), { recursive: true, force: true }).catch(() => {})
  if (asset.refId) await deleteReference(asset.refId).catch(() => {})
  touchProject(asset.projectId)
}
