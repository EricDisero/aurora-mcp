// Aurora userData + project-root resolution WITHOUT Electron. The desktop app
// resolves these via app.getPath('userData'); we hardcode-resolve the same
// locations per OS (the handoff plan's blessed approach). The app's Electron
// name is `aurora` (package.json name) in dev and productName `Aurora` when
// packaged — same directory on the case-insensitive default filesystems of
// Windows/macOS; on Linux we probe both casings and prefer the one holding
// aurora.db.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings } from './types.js'

const SETTINGS_DEFAULTS: AppSettings = {
  projectsDirectory: '',
  outputDirectory: '',
  defaultGenModel: 'V5',
  defaultSmoothing: 0.5,
  defaultBitDepth: 24
}

function userDataCandidates(): string[] {
  const home = homedir()
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    return [join(appData, 'aurora'), join(appData, 'Aurora')]
  }
  if (process.platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support')
    return [join(base, 'aurora'), join(base, 'Aurora')]
  }
  const base = process.env.XDG_CONFIG_HOME || join(home, '.config')
  return [join(base, 'aurora'), join(base, 'Aurora')]
}

/** Aurora's userData directory. AURORA_USER_DATA overrides (also how the test
 *  harness isolates); otherwise the per-OS Electron location, preferring the
 *  casing variant that already holds aurora.db. */
export function getUserDataDir(): string {
  if (process.env.AURORA_USER_DATA) return process.env.AURORA_USER_DATA
  const candidates = userDataCandidates()
  for (const c of candidates) {
    if (existsSync(join(c, 'aurora.db'))) return c
  }
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}

export function getDbPath(): string {
  return join(getUserDataDir(), 'aurora.db')
}

/** Read the app's settings.json, merging saved values over defaults (the app's
 *  own semantics — missing keys fall to default). Read-only here: the MCP never
 *  writes settings. */
export function getSettings(): AppSettings {
  const path = join(getUserDataDir(), 'settings.json')
  if (!existsSync(path)) return { ...SETTINGS_DEFAULTS }
  try {
    const saved = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AppSettings>
    return { ...SETTINGS_DEFAULTS, ...saved }
  } catch {
    return { ...SETTINGS_DEFAULTS }
  }
}

/** Active projects root — the custom setting if set, else userData/projects. */
export function getProjectsDirectory(): string {
  return getSettings().projectsDirectory || join(getUserDataDir(), 'projects')
}

/** Global reference library dir (userData/references/<refId>/ holds the copied
 *  audio + cached curve files). */
export function getReferencesDir(): string {
  return join(getUserDataDir(), 'references')
}

/** Where MCP background-job manifests live. */
export function getJobsDir(): string {
  return join(getUserDataDir(), 'agent-jobs')
}
