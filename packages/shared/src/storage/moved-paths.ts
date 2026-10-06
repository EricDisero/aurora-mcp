// Port of aurora/src/main/storage/moved-paths.ts.
import { isAbsolute, join, relative, sep } from 'node:path'
import { getDb } from '../db.js'

/** Rewrite references across all sets, including sets owned by another asset. */
export function rewriteStemPaths(moves: Array<[string, string]>): void {
  const db = getDb()
  for (const [table, column] of [['stem_lanes', 'path'], ['stem_sets', 'source_path']]) {
    const rows = db.prepare(`SELECT id, ${column} AS path FROM ${table} WHERE ${column} IS NOT NULL`)
      .all() as Array<{ id: string; path: string }>
    const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`)
    for (const row of rows) {
      for (const [from, to] of moves) {
        const rel = relative(from, row.path)
        if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) {
          update.run(rel ? join(to, rel) : to, row.id)
          break
        }
      }
    }
  }
}
