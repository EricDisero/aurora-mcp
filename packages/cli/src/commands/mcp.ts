// `aurora mcp` — print the MCP client config for this machine, with the key
// envs inlined when configured (keys in ~/.aurora/config.json are read by the
// server directly, so the env block is optional in that case).

import { getKieKey, getMvsepKey, getSunoKey, readKeyConfig } from '@ericdisero/aurora-shared'

export function runMcpConfig(): void {
  const fileConfig = readKeyConfig()
  const needsEnvBlock = !fileConfig.sunoApiKey && !fileConfig.kieApiKey && !fileConfig.mvsepApiKey

  const env: Record<string, string> = {}
  if (needsEnvBlock) {
    if (getSunoKey()) env.SUNO_API_KEY = '<your sunoapi.org key>'
    if (getKieKey()) env.KIE_API_KEY = '<your kie.ai key>'
    if (getMvsepKey()) env.MVSEP_API_KEY = '<your mvsep key>'
    if (Object.keys(env).length === 0) {
      env.SUNO_API_KEY = '<your sunoapi.org key>'
      env.MVSEP_API_KEY = '<your mvsep key>'
    }
  }

  const server: Record<string, unknown> = {
    command: 'npx',
    args: ['-y', '@ericdisero/aurora-mcp-server']
  }
  if (Object.keys(env).length > 0) server.env = env

  const config = { mcpServers: { aurora: server } }

  console.log('Add to your MCP config (Claude Desktop: claude_desktop_config.json,')
  console.log('Claude Code: `claude mcp add-json aurora ...` or .mcp.json, Cursor: mcp.json):\n')
  console.log(JSON.stringify(config, null, 2))
  if (!needsEnvBlock) {
    console.log('\nKeys found in ~/.aurora/config.json — the server reads them directly, no env block needed.')
  } else {
    console.log('\nTip: `aurora keys --suno-api-key <key> --mvsep-api-key <key>` stores keys in')
    console.log('~/.aurora/config.json so the env block becomes unnecessary.')
  }
  console.log('\nClaude Code one-liner:')
  console.log('  claude mcp add aurora -- npx -y @ericdisero/aurora-mcp-server')
}
