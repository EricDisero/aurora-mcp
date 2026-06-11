// `aurora keys` — provider key configuration (~/.aurora/config.json).
// No flags = status (masked). Aurora itself has no auth (testing build);
// these are the dev-direct provider keys.

import {
  getConfigPath,
  getKieKey,
  getMvsepKey,
  getSunoKey,
  writeKeyConfig
} from '@ericdisero/aurora-shared'

interface KeysOptions {
  sunoApiKey?: string
  kieApiKey?: string
  mvsepApiKey?: string
}

function mask(key: string | undefined): string {
  if (!key) return 'NOT SET'
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

export function runKeys(opts: KeysOptions): void {
  const updates: Record<string, string> = {}
  if (opts.sunoApiKey) updates.sunoApiKey = opts.sunoApiKey
  if (opts.kieApiKey) updates.kieApiKey = opts.kieApiKey
  if (opts.mvsepApiKey) updates.mvsepApiKey = opts.mvsepApiKey

  if (Object.keys(updates).length > 0) {
    writeKeyConfig(updates)
    console.log(`Saved to ${getConfigPath()}`)
  }

  console.log('Provider keys (env vars override the config file):')
  console.log(`  suno  (SUNO_API_KEY):  ${mask(getSunoKey())}  ← PRIMARY (sunoapi.org)`)
  console.log(`  kie   (KIE_API_KEY):   ${mask(getKieKey())}  ← fallback (api.kie.ai)`)
  console.log(`  mvsep (MVSEP_API_KEY): ${mask(getMvsepKey())}  ← stem separation`)
  if (!getSunoKey() && !getKieKey()) {
    console.log('\nNo Suno provider key — generation/cover/sounds ops will fail.')
    console.log('Set one: aurora keys --suno-api-key <key>')
  }
}
