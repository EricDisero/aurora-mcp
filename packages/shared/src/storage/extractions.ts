import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import type { ExtractionStem } from '../types.js'
import { deriveStemRecipe, parseRecipe, type Recipe } from '../recipe.js'

// Sample Extractor results (schema v2). Port of aurora
// src/main/storage/extractions.ts — one row per (asset, catalog stem id);
// a re-run replaces the same stem in place (mirrors the split discipline).

interface ExtractionRow {
  id: string
  project_id: string
  asset_id: string
  stem_id: string
  path: string
  detected_key: string | null
  created_at: number
  recipe: string | null
}

function rowToStem(row: ExtractionRow): ExtractionStem {
  return {
    id: row.id,
    projectId: row.project_id,
    assetId: row.asset_id,
    stemId: row.stem_id,
    path: row.path,
    detectedKey: row.detected_key,
    createdAt: row.created_at,
    recipe:
      parseRecipe(row.recipe) ??
      deriveStemRecipe({ table: 'extraction_stems', assetId: row.asset_id, stemKey: row.stem_id, createdAt: row.created_at })
  }
}

export function getExtractionStems(assetId: string): ExtractionStem[] {
  const rows = getDb()
    .prepare('SELECT * FROM extraction_stems WHERE asset_id = ? ORDER BY stem_id')
    .all(assetId) as ExtractionRow[]
  return rows.map(rowToStem)
}

export function getProjectExtractionStems(projectId: string): ExtractionStem[] {
  const rows = getDb()
    .prepare('SELECT * FROM extraction_stems WHERE project_id = ? ORDER BY asset_id, stem_id')
    .all(projectId) as ExtractionRow[]
  return rows.map(rowToStem)
}

export function upsertExtractionStem(params: {
  projectId: string
  assetId: string
  stemId: string
  path: string
  detectedKey: string | null
  /** What made it. Absent: derived from the row, with `missing` saying what is not known. */
  recipe?: Recipe | null
}): ExtractionStem {
  const db = getDb()
  const id = randomUUID()
  const now = Date.now()
  const recipe =
    params.recipe ?? deriveStemRecipe({ table: 'extraction_stems', assetId: params.assetId, stemKey: params.stemId, createdAt: now })

  db.prepare(
    `INSERT INTO extraction_stems (id, project_id, asset_id, stem_id, path, detected_key, created_at, recipe)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset_id, stem_id)
     DO UPDATE SET path = excluded.path, detected_key = excluded.detected_key, created_at = excluded.created_at, recipe = excluded.recipe`
  ).run(id, params.projectId, params.assetId, params.stemId, params.path, params.detectedKey, now, JSON.stringify(recipe))

  const row = db
    .prepare('SELECT * FROM extraction_stems WHERE asset_id = ? AND stem_id = ?')
    .get(params.assetId, params.stemId) as ExtractionRow
  return rowToStem(row)
}

export function deleteExtractionStemsForAsset(assetId: string): void {
  getDb().prepare('DELETE FROM extraction_stems WHERE asset_id = ?').run(assetId)
}
