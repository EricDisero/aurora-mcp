// Port of aurora/src/main/storage/stems.ts.

import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import type { ProjectStem, StemType } from '../types.js'

interface StemRow {
  id: string
  project_id: string
  asset_id: string
  stem_type: StemType
  path: string
  origin: 'mvsep' | 'synthesized'
}

function rowToStem(row: StemRow): ProjectStem {
  return {
    id: row.id,
    projectId: row.project_id,
    assetId: row.asset_id,
    stemType: row.stem_type,
    path: row.path,
    origin: row.origin
  }
}

/** Stems of one split set (an asset's). */
export function getStems(assetId: string): ProjectStem[] {
  const rows = getDb()
    .prepare('SELECT * FROM project_stems WHERE asset_id = ? ORDER BY stem_type')
    .all(assetId) as StemRow[]
  return rows.map(rowToStem)
}

/** All split sets in a project. */
export function getProjectStems(projectId: string): ProjectStem[] {
  const rows = getDb()
    .prepare('SELECT * FROM project_stems WHERE project_id = ? ORDER BY asset_id, stem_type')
    .all(projectId) as StemRow[]
  return rows.map(rowToStem)
}

/** Upsert a stem row (one per asset+stem_type — the unique index enforces it). */
export function upsertStem(params: {
  projectId: string
  assetId: string
  stemType: StemType
  path: string
  origin: 'mvsep' | 'synthesized'
}): ProjectStem {
  const db = getDb()
  const id = uuidv4()

  db.prepare(
    `INSERT INTO project_stems (id, project_id, asset_id, stem_type, path, origin)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset_id, stem_type)
     DO UPDATE SET path = excluded.path, origin = excluded.origin`
  ).run(id, params.projectId, params.assetId, params.stemType, params.path, params.origin)

  const row = db
    .prepare('SELECT * FROM project_stems WHERE asset_id = ? AND stem_type = ?')
    .get(params.assetId, params.stemType) as StemRow
  return rowToStem(row)
}
