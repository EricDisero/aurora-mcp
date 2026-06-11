// Port of aurora/src/main/storage/references.ts (userData/references instead
// of app.getPath).

import { join, basename, extname } from 'node:path'
import { mkdir, copyFile, rm } from 'node:fs/promises'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import { getReferencesDir } from '../paths.js'
import type { ReferenceTrack } from '../types.js'

type CurveStatus = ReferenceTrack['curveStatus']

interface ReferenceRow {
  id: string
  name: string
  audio_path: string
  cached_curve_path: string | null
  curve_status: CurveStatus
  created_at: number
}

function rowToReference(row: ReferenceRow): ReferenceTrack {
  return {
    id: row.id,
    name: row.name,
    audioPath: row.audio_path,
    cachedCurvePath: row.cached_curve_path,
    curveStatus: row.curve_status,
    createdAt: row.created_at
  }
}

export function getReferenceDir(id: string): string {
  return join(getReferencesDir(), id)
}

export function listReferences(): ReferenceTrack[] {
  const rows = getDb()
    .prepare('SELECT * FROM reference_tracks ORDER BY created_at DESC')
    .all() as ReferenceRow[]
  return rows.map(rowToReference)
}

export function getReference(id: string): ReferenceTrack | null {
  const row = getDb().prepare('SELECT * FROM reference_tracks WHERE id = ?').get(id) as
    | ReferenceRow
    | undefined
  return row ? rowToReference(row) : null
}

/** Add a reference row (status 'none'). `copy: false` points the row at the
 *  given path directly (project-scoped reference assets own their file). */
export async function addReference(
  sourcePath: string,
  opts: { copy?: boolean } = {}
): Promise<ReferenceTrack> {
  const id = uuidv4()
  const dir = getReferenceDir(id)
  await mkdir(dir, { recursive: true })

  const ext = extname(sourcePath) || '.wav'
  let audioPath = sourcePath
  if (opts.copy !== false) {
    audioPath = join(dir, `audio${ext}`)
    await copyFile(sourcePath, audioPath)
  }

  const name = basename(sourcePath, ext) || 'Reference'
  getDb()
    .prepare(
      `INSERT INTO reference_tracks (id, name, audio_path, cached_curve_path, curve_status, created_at)
       VALUES (?, ?, ?, NULL, 'none', ?)`
    )
    .run(id, name, audioPath, Date.now())

  return getReference(id)!
}

export async function deleteReference(id: string): Promise<void> {
  getDb().prepare('DELETE FROM reference_tracks WHERE id = ?').run(id)
  await rm(getReferenceDir(id), { recursive: true, force: true }).catch(() => {})
}
