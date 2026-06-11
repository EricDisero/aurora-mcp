#!/usr/bin/env node
import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runOp, listOps } from './commands/op.js'
import { runInstallSkills } from './commands/install-skills.js'
import { runKeys } from './commands/keys.js'
import { runStatus } from './commands/status.js'
import { runMcpConfig } from './commands/mcp.js'

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
) as { version: string }

const program = new Command()

program
  .name('aurora')
  .description(
    'Aurora AI audio workbench CLI — generation, covers, sounds, 7-stem splits, stack export. ' +
      'Agent-first: `aurora run <op> --key value` mirrors the MCP tool surface.'
  )
  .version(pkg.version)

program
  .command('run [op]')
  .description('Run an operation, e.g. `aurora run aurora_create_project --name "Midnight Drive"`')
  .option('--list', 'List every operation with its description')
  .option('--json', 'Machine-readable output ({text, data})')
  .allowUnknownOption(true)
  .action(async (opId: string | undefined, opts: { list?: boolean; json?: boolean }, cmd: Command) => {
    if (opts.list || !opId) {
      listOps()
      return
    }
    await runOp({ opId, rawArgs: cmd.args.slice(1), json: Boolean(opts.json) })
  })

program
  .command('install-skills')
  .description("Install the bundled agent skills into Claude Code's skill directory (.claude/skills/<name>/SKILL.md)")
  .option('--global', 'Install to ~/.claude/skills instead of ./.claude/skills')
  .action((opts: { global?: boolean }) => {
    runInstallSkills({ global: Boolean(opts.global) })
  })

program
  .command('keys')
  .description('Configure provider API keys (~/.aurora/config.json). `aurora keys` shows status.')
  .option('--suno-api-key <key>', 'sunoapi.org key (PRIMARY Suno provider)')
  .option('--kie-api-key <key>', 'kie.ai key (fallback Suno provider)')
  .option('--mvsep-api-key <key>', 'MVSEP key (stem separation)')
  .action((opts: { sunoApiKey?: string; kieApiKey?: string; mvsepApiKey?: string }) => {
    runKeys(opts)
  })

program
  .command('status')
  .description('Show Aurora connection state: userData, database, projects root, key status')
  .action(async () => {
    await runStatus()
  })

program
  .command('mcp')
  .description('Print the MCP client config for this machine (Claude Code / Claude Desktop / Cursor)')
  .action(() => {
    runMcpConfig()
  })

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
