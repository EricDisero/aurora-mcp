// Port of aurora/src/main/storage/projects.ts — identical DB rows + folder
// semantics so the app and the MCP see one library.

import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import { getProjectsDirectory } from '../paths.js'
import type { Project } from '../types.js'

interface ProjectRow {
  id: string
  name: string
  dir_name: string | null
  created_at: number
  updated_at: number
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    dirName: row.dir_name || row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** Filesystem-safe slug for human-readable project folders. */
export function slugify(input: string, max = 60): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return slug || 'project'
}

function uniqueDirName(name: string): string {
  const base = slugify(name)
  const root = getProjectsDirectory()
  const taken = (dir: string): boolean =>
    existsSync(join(root, dir)) ||
    Boolean(getDb().prepare('SELECT 1 FROM projects WHERE dir_name = ?').get(dir))
  if (!taken(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!taken(candidate)) return candidate
  }
}

/** Absolute path to a project's directory. Legacy projects use their uuid dir. */
export function getProjectDirectory(projectId: string): string {
  const row = getDb().prepare('SELECT dir_name FROM projects WHERE id = ?').get(projectId) as
    | { dir_name: string | null }
    | undefined
  return join(getProjectsDirectory(), row?.dir_name || projectId)
}

export function listProjects(): Project[] {
  const rows = getDb()
    .prepare('SELECT id, name, dir_name, created_at, updated_at FROM projects ORDER BY updated_at DESC')
    .all() as ProjectRow[]
  return rows.map(rowToProject)
}

export function getProject(id: string): Project | null {
  const row = getDb()
    .prepare('SELECT id, name, dir_name, created_at, updated_at FROM projects WHERE id = ?')
    .get(id) as ProjectRow | undefined
  return row ? rowToProject(row) : null
}

export async function createProject(name: string): Promise<Project> {
  const id = uuidv4()
  const dirName = uniqueDirName(name)
  await mkdir(join(getProjectsDirectory(), dirName), { recursive: true })

  const now = Date.now()
  // source/audio_path are dormant v0 columns (kept for the migration path).
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, source, audio_path, gen_meta, dir_name, created_at, updated_at)
       VALUES (?, ?, 'imported', '', NULL, ?, ?, ?)`
    )
    .run(id, name.trim() || 'Untitled project', dirName, now, now)

  return getProject(id)!
}

/** Rename the project (DB name only — the on-disk folder keeps its name). */
export function renameProject(id: string, name: string): Project {
  getDb()
    .prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
    .run(name.trim() || 'Untitled project', Date.now(), id)
  return getProject(id)!
}

export function touchProject(id: string): void {
  getDb().prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), id)
}

export async function deleteProject(id: string): Promise<void> {
  const dir = getProjectDirectory(id)
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
