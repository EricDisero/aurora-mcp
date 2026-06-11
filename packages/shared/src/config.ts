// Provider API-key resolution. Priority: environment variables (works with the
// MCP config `env` block and CI) → ~/.aurora/config.json (written by
// `aurora keys set`). Auth to Aurora itself: NONE — the app runs fully open
// (AUTH_ENABLED=false; slates-api device-code auth arrives with D4, out of
// scope here). These keys are the PROVIDER dev keys (dev-direct mode).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AuroraKeyConfig {
  sunoApiKey?: string
  kieApiKey?: string
  mvsepApiKey?: string
  sunoApiBaseUrl?: string
}

export function getConfigPath(): string {
  return join(homedir(), '.aurora', 'config.json')
}

export function readKeyConfig(): AuroraKeyConfig {
  const path = getConfigPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AuroraKeyConfig
  } catch {
    return {}
  }
}

export function writeKeyConfig(partial: AuroraKeyConfig): AuroraKeyConfig {
  const merged = { ...readKeyConfig(), ...partial }
  const dir = join(homedir(), '.aurora')
  mkdirSync(dir, { recursive: true })
  writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2))
  return merged
}

export function getSunoKey(): string | undefined {
  return process.env.SUNO_API_KEY || readKeyConfig().sunoApiKey
}

export function getKieKey(): string | undefined {
  return process.env.KIE_API_KEY || readKeyConfig().kieApiKey
}

export function getSunoBaseUrlOverride(): string | undefined {
  return process.env.SUNO_API_BASE_URL || readKeyConfig().sunoApiBaseUrl
}

export function getMvsepKey(): string | undefined {
  return process.env.MVSEP_API_KEY || readKeyConfig().mvsepApiKey
}

export function requireMvsepKey(): string {
  const key = getMvsepKey()
  if (!key) {
    throw new Error(
      'MVSEP_API_KEY is not configured. Set the MVSEP_API_KEY environment variable ' +
        '(e.g. in your MCP config "env" block) or run: aurora keys set --mvsep-api-key <key>'
    )
  }
  return key
}
