import { existsSync, statSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import { normalizeStemId } from '../types.js'
import type { CreateStemSetParams, StoredStemLane, StoredStemSet } from '../types.js'

// Port of aurora/src/main/storage/stem-sets.ts.
interface SetRow {
  id: string
  project_id: string
  asset_id: string
  kind: 'import' | 'custom'
  name: string
  source_path: string | null
  created_at: number
}

interface LaneRow {
  id: string
  set_id: string
  stem_key: string
  label: string
  path: string
  sort_order: number
}

function rowToSet(row: SetRow): StoredStemSet {
  const lanes = getDb()
    .prepare('SELECT * FROM stem_lanes WHERE set_id = ? ORDER BY sort_order, rowid')
    .all(row.id) as LaneRow[]
  return {
    id: row.id,
    projectId: row.project_id,
    assetId: row.asset_id,
    kind: row.kind,
    name: row.name,
    sourcePath: row.source_path,
    createdAt: row.created_at,
    lanes: lanes.map((lane): StoredStemLane => ({
      id: lane.id,
      setId: lane.set_id,
      stemKey: lane.stem_key,
      label: lane.label,
      path: lane.path,
      sortOrder: lane.sort_order
    }))
  }
}

export function createStemSet(params: CreateStemSetParams): StoredStemSet {
  const db = getDb()
  return db.transaction(() => {
    const asset = db.prepare('SELECT project_id FROM project_assets WHERE id = ?').get(params.assetId) as
      | { project_id: string }
      | undefined
    if (!asset) throw new Error(`Asset not found: ${params.assetId}`)
    if (asset.project_id !== params.projectId) throw new Error('Stem set project does not match its asset.')
    if (params.kind !== 'import' && params.kind !== 'custom') throw new Error('Invalid stem set kind.')
    if (!params.name?.trim()) throw new Error('Stem set name is required.')
    if (!Array.isArray(params.lanes) || !params.lanes.length) throw new Error('No stem lanes provided.')
    if (params.sourcePath !== undefined && !isAbsolute(params.sourcePath)) {
      throw new Error(`Stem set source path must be absolute: ${params.sourcePath}`)
    }
    const keys = new Set<string>()
    for (const lane of params.lanes) {
      if (!lane.path || !isAbsolute(lane.path)) {
        throw new Error(`Stem lane path must be absolute: ${lane.path}`)
      }
      if (!existsSync(lane.path) || !statSync(lane.path).isFile()) {
        throw new Error(`Stem lane file not found: ${lane.path}`)
      }
      const key = normalizeStemId(lane.stemKey)
      if (!key?.trim()) throw new Error('Stem lane key is required.')
      if (keys.has(key)) throw new Error(`Duplicate stem lane key: ${key}`)
      keys.add(key)
      if (!lane.label?.trim()) throw new Error(`Stem lane label is required: ${key}`)
    }

    const id = uuidv4()
    db.prepare(
      `INSERT INTO stem_sets (id, project_id, asset_id, kind, name, source_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, params.projectId, params.assetId, params.kind, params.name.trim(),
      params.sourcePath === undefined ? null : normalize(params.sourcePath), Date.now())
    const insertLane = db.prepare(
      `INSERT INTO stem_lanes (id, set_id, stem_key, label, path, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    params.lanes.forEach((lane, index) => {
      insertLane.run(uuidv4(), id, normalizeStemId(lane.stemKey), lane.label, lane.path, index)
    })
    return rowToSet(db.prepare('SELECT * FROM stem_sets WHERE id = ?').get(id) as SetRow)
  })()
}

export function listStoredSets(assetId: string): StoredStemSet[] {
  const rows = getDb()
    .prepare('SELECT * FROM stem_sets WHERE asset_id = ? ORDER BY created_at, rowid')
    .all(assetId) as SetRow[]
  return rows.map(rowToSet)
}

// Sets own rows, never the files their lanes reference.
export function deleteStemSet(id: string): void {
  getDb().prepare('DELETE FROM stem_sets WHERE id = ?').run(id)
}

export function deleteSetsForAsset(assetId: string): void {
  getDb().prepare('DELETE FROM stem_sets WHERE asset_id = ?').run(assetId)
}
