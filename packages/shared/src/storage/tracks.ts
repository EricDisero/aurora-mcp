// Port of aurora/src/main/storage/tracks.ts — identical track rows + on-disk
// subfolder semantics so the app and MCP see one library. Schema v3.
//
// NOTE: this module and ./assets form a function-level import cycle (assets.ts
// imports getTrackDirectory here for path-building; deleteTrack here imports
// setAssetTrack to unfile a track's assets before removal). Both references are
// used only inside function bodies, so the cycle is safe under tsc/Node ESM.

import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import { getProjectDirectory, slugify } from './projects.js'
import { setAssetTrack } from './assets.js'
import type { Track } from '../types.js'

interface TrackRow {
  id: string
  project_id: string
  name: string
  dir_name: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

function rowToTrack(row: TrackRow): Track {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    dirName: row.dir_name || row.id,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function uniqueDirName(projectId: string, name: string): string {
  const base = slugify(name)
  const projectDir = getProjectDirectory(projectId)
  const taken = (dir: string): boolean =>
    existsSync(join(projectDir, dir)) ||
    Boolean(
      getDb()
        .prepare('SELECT 1 FROM tracks WHERE project_id = ? AND dir_name = ?')
        .get(projectId, dir)
    )
  if (!taken(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!taken(candidate)) return candidate
  }
}

/** Absolute path to a track's subfolder under its project. */
export function getTrackDirectory(trackId: string): string {
  const row = getDb()
    .prepare('SELECT project_id, dir_name FROM tracks WHERE id = ?')
    .get(trackId) as { project_id: string; dir_name: string | null } | undefined
  if (!row) throw new Error(`track not found: ${trackId}`)
  return join(getProjectDirectory(row.project_id), row.dir_name || trackId)
}

export function listTracks(projectId: string): Track[] {
  const rows = getDb()
    .prepare('SELECT * FROM tracks WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC')
    .all(projectId) as TrackRow[]
  return rows.map(rowToTrack)
}

export function getTrack(id: string): Track | null {
  const row = getDb().prepare('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow | undefined
  return row ? rowToTrack(row) : null
}

export async function createTrack(projectId: string, name: string): Promise<Track> {
  const id = uuidv4()
  const dirName = uniqueDirName(projectId, name)
  await mkdir(join(getProjectDirectory(projectId), dirName), { recursive: true })

  const maxOrder = getDb()
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM tracks WHERE project_id = ?')
    .get(projectId) as { m: number }

  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO tracks (id, project_id, name, dir_name, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, projectId, name.trim() || 'Untitled track', dirName, maxOrder.m + 1, now, now)

  return getTrack(id)!
}

export function renameTrack(id: string, name: string): Track {
  getDb()
    .prepare('UPDATE tracks SET name = ?, updated_at = ? WHERE id = ?')
    .run(name.trim() || 'Untitled track', Date.now(), id)
  return getTrack(id)!
}

export function reorderTracks(projectId: string, orderedIds: string[]): Track[] {
  const stmt = getDb().prepare('UPDATE tracks SET sort_order = ? WHERE id = ? AND project_id = ?')
  getDb().transaction(() => {
    orderedIds.forEach((id, i) => stmt.run(i, id, projectId))
  })()
  return listTracks(projectId)
}

/** Delete a track non-destructively: its assets move back to unfiled (files
 *  relocate to the project root), then the now-empty folder is removed. */
export async function deleteTrack(id: string): Promise<void> {
  const track = getTrack(id)
  if (!track) return

  const assetIds = getDb()
    .prepare('SELECT id FROM project_assets WHERE track_id = ?')
    .all(id) as Array<{ id: string }>
  for (const a of assetIds) {
    await setAssetTrack(a.id, null)
  }

  const dir = getTrackDirectory(id)
  getDb().prepare('DELETE FROM tracks WHERE id = ?').run(id)
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
