// Aurora DB access without Electron — same better-sqlite3, same WAL pragmas,
// same migrations as aurora/src/main/database/. The MCP and the running app
// can coexist on this DB: WAL allows concurrent readers, busy_timeout waits
// out transient writer locks.
//
// SCHEMA LOCKSTEP RULE: this file mirrors aurora/src/main/database/migrations.ts
// at schema version 5. If the app migrates past v5, openDb() refuses to write
// with an "update your aurora-mcp packages" error instead of corrupting newer
// schema assumptions.

import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { getDbPath, getUserDataDir } from './paths.js'

const KNOWN_SCHEMA_VERSION = 5

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db

  mkdirSync(getUserDataDir(), { recursive: true })
  db = new Database(getDbPath())
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  const version = db.pragma('user_version', { simple: true }) as number
  if (version > KNOWN_SCHEMA_VERSION) {
    const path = getDbPath()
    db.close()
    db = null
    throw new Error(
      `Aurora database at ${path} is schema v${version}, newer than this tool understands (v${KNOWN_SCHEMA_VERSION}). ` +
        'Update the @ericdisero/aurora-* packages (npm i -g @ericdisero/aurora-cli@latest, or clear the npx cache).'
    )
  }

  runMigrations(db)
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

// Verbatim port of aurora/src/main/database/migrations.ts (schema v1).
function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      source      TEXT NOT NULL CHECK(source IN ('generated', 'imported')),
      audio_path  TEXT NOT NULL,
      gen_meta    TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_stems (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      stem_type   TEXT NOT NULL CHECK(stem_type IN ('vocals','kick','snare','toms','hats','bass','ee')),
      path        TEXT NOT NULL,
      origin      TEXT NOT NULL CHECK(origin IN ('mvsep','synthesized','imported')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reference_tracks (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      audio_path         TEXT NOT NULL,
      cached_curve_path  TEXT,
      curve_status       TEXT NOT NULL DEFAULT 'none'
                         CHECK(curve_status IN ('none','analyzing','cached','error')),
      created_at         INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_project_stems_project ON project_stems(project_id);
    CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
  `)

  const version = database.pragma('user_version', { simple: true }) as number

  if (version < 1) {
    database.transaction(() => {
      database.exec(`
        ALTER TABLE projects ADD COLUMN dir_name TEXT;

        CREATE TABLE IF NOT EXISTS project_assets (
          id               TEXT PRIMARY KEY,
          project_id       TEXT NOT NULL,
          kind             TEXT NOT NULL CHECK(kind IN ('generation','cover','import','reference','master')),
          name             TEXT NOT NULL,
          path             TEXT NOT NULL,
          origin           TEXT,
          source_asset_id  TEXT,
          ref_id           TEXT,
          created_at       INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_project_assets_project ON project_assets(project_id);

        ALTER TABLE project_stems ADD COLUMN asset_id TEXT;
        DROP INDEX IF EXISTS idx_project_stems_unique;
        CREATE INDEX IF NOT EXISTS idx_project_stems_asset ON project_stems(asset_id);
      `)

      const projects = database
        .prepare('SELECT id, name, source, audio_path, gen_meta, created_at FROM projects')
        .all() as Array<{
        id: string
        name: string
        source: 'generated' | 'imported'
        audio_path: string
        gen_meta: string | null
        created_at: number
      }>

      const setDir = database.prepare('UPDATE projects SET dir_name = ? WHERE id = ?')
      const insertAsset = database.prepare(
        `INSERT INTO project_assets (id, project_id, kind, name, path, origin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      const linkStems = database.prepare('UPDATE project_stems SET asset_id = ? WHERE project_id = ?')

      for (const p of projects) {
        setDir.run(p.id, p.id)
        if (p.audio_path) {
          const assetId = randomUUID()
          const kind = p.source === 'generated' ? 'generation' : 'import'
          insertAsset.run(assetId, p.id, kind, p.name, p.audio_path, p.gen_meta, p.created_at)
          linkStems.run(assetId, p.id)
        }
      }

      database.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_project_stems_asset_unique ON project_stems(asset_id, stem_type);'
      )

      database.pragma('user_version = 1')
    })()
  }

  // v2 — Sample Extractor results (extraction_stems), verbatim mirror of the
  // app's v2 migration. Unique per (asset_id, stem_id): re-runs replace rows.
  if ((database.pragma('user_version', { simple: true }) as number) < 2) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS extraction_stems (
          id            TEXT PRIMARY KEY,
          project_id    TEXT NOT NULL,
          asset_id      TEXT NOT NULL,
          stem_id       TEXT NOT NULL,
          path          TEXT NOT NULL,
          detected_key  TEXT,
          created_at    INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_extraction_stems_asset ON extraction_stems(asset_id);
        CREATE INDEX IF NOT EXISTS idx_extraction_stems_project ON extraction_stems(project_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_extraction_stems_asset_unique
          ON extraction_stems(asset_id, stem_id);
      `)
      database.pragma('user_version = 2')
    })()
  }

  // v3 — Tracks (project subfolders) + asset favorites, verbatim mirror of the
  // app's v3 migration. track_id nullable (NULL = unfiled, flat at project root);
  // favorite 0/1 default 0.
  if ((database.pragma('user_version', { simple: true }) as number) < 3) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS tracks (
          id          TEXT PRIMARY KEY,
          project_id  TEXT NOT NULL,
          name        TEXT NOT NULL,
          dir_name    TEXT,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_tracks_project ON tracks(project_id);

        ALTER TABLE project_assets ADD COLUMN track_id TEXT;
        ALTER TABLE project_assets ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS idx_project_assets_track ON project_assets(track_id);
      `)
      database.pragma('user_version = 3')
    })()
  }

  // v4 — Bring-your-own-stems: project_stems.origin gains 'imported'. Verbatim
  // mirror of the app's v4 (table rebuild — SQLite can't ALTER a CHECK).
  if ((database.pragma('user_version', { simple: true }) as number) < 4) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE project_stems_v4 (
          id          TEXT PRIMARY KEY,
          project_id  TEXT NOT NULL,
          asset_id    TEXT,
          stem_type   TEXT NOT NULL CHECK(stem_type IN ('vocals','kick','snare','toms','hats','bass','ee')),
          path        TEXT NOT NULL,
          origin      TEXT NOT NULL CHECK(origin IN ('mvsep','synthesized','imported')),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        INSERT INTO project_stems_v4 (id, project_id, asset_id, stem_type, path, origin)
          SELECT id, project_id, asset_id, stem_type, path, origin FROM project_stems;
        DROP TABLE project_stems;
        ALTER TABLE project_stems_v4 RENAME TO project_stems;
        CREATE INDEX IF NOT EXISTS idx_project_stems_project ON project_stems(project_id);
        CREATE INDEX IF NOT EXISTS idx_project_stems_asset ON project_stems(asset_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_project_stems_asset_unique
          ON project_stems(asset_id, stem_type);
      `)
      database.pragma('user_version = 4')
    })()
  }

  // v5 — Kind collapse: import + reference merge into one neutral 'track' kind.
  // Verbatim mirror of the app's v5 (table rebuild — SQLite can't ALTER a CHECK).
  // project_assets CHECK becomes generation|cover|track|master; existing
  // import/reference rows data-migrate to 'track'. Files left where they are.
  if ((database.pragma('user_version', { simple: true }) as number) < 5) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE project_assets_v5 (
          id               TEXT PRIMARY KEY,
          project_id       TEXT NOT NULL,
          kind             TEXT NOT NULL CHECK(kind IN ('generation','cover','track','master')),
          name             TEXT NOT NULL,
          path             TEXT NOT NULL,
          origin           TEXT,
          source_asset_id  TEXT,
          ref_id           TEXT,
          track_id         TEXT,
          favorite         INTEGER NOT NULL DEFAULT 0,
          created_at       INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        INSERT INTO project_assets_v5
          (id, project_id, kind, name, path, origin, source_asset_id, ref_id, track_id, favorite, created_at)
          SELECT id, project_id,
                 CASE WHEN kind IN ('import','reference') THEN 'track' ELSE kind END,
                 name, path, origin, source_asset_id, ref_id, track_id, favorite, created_at
            FROM project_assets;
        DROP TABLE project_assets;
        ALTER TABLE project_assets_v5 RENAME TO project_assets;
        CREATE INDEX IF NOT EXISTS idx_project_assets_project ON project_assets(project_id);
        CREATE INDEX IF NOT EXISTS idx_project_assets_track ON project_assets(track_id);
      `)
      database.pragma('user_version = 5')
    })()
  }
}
