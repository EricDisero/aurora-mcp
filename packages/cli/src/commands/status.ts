// `aurora status` — where Aurora's data lives + key state, with a clear
// message when the app has never run on this machine.

import { existsSync } from 'node:fs'
import {
  getDbPath,
  getKieKey,
  getMvsepKey,
  getProjectsDirectory,
  getSunoKey,
  getUserDataDir
} from '@ericdisero/aurora-shared'

export async function runStatus(): Promise<void> {
  const userData = getUserDataDir()
  const dbPath = getDbPath()
  const dbExists = existsSync(dbPath)

  console.log(`userData:       ${userData}`)
  console.log(`database:       ${dbPath} ${dbExists ? '(exists)' : '(MISSING — created on first op)'}`)
  console.log(`projects root:  ${getProjectsDirectory()}`)
  console.log(`suno key:       ${getSunoKey() ? 'configured' : getKieKey() ? 'kie fallback configured' : 'NOT SET'}`)
  console.log(`mvsep key:      ${getMvsepKey() ? 'configured' : 'NOT SET'}`)

  if (!dbExists) {
    console.log(
      '\nNo Aurora database yet — either the Aurora app has never run on this machine, or it uses a ' +
        'different userData dir (set AURORA_USER_DATA to override). The first project/asset op will ' +
        'create a fresh library here.'
    )
  }
}
