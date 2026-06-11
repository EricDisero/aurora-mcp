// Install the bundled skill markdown into Claude Code's skill directories.
// Claude Code discovers skills as DIRECTORIES: .claude/skills/<name>/SKILL.md —
// a loose .md dropped into skills/ is silently never loaded (the slates-mcp
// 6/9 audit lesson, baked in from day one here).

import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { SKILLS } from '@ericdisero/aurora-shared'

interface InstallSkillsOptions {
  global?: boolean
}

function frontmatterName(markdown: string, fallback: string): string {
  if (!markdown.startsWith('---')) return fallback
  const end = markdown.indexOf('\n---', 3)
  if (end === -1) return fallback
  const m = markdown.slice(3, end).match(/^name:\s*(.+?)\s*$/m)
  return m ? m[1].trim() : fallback
}

export function runInstallSkills(opts: InstallSkillsOptions): void {
  const skillEntries = Object.entries(SKILLS)
  if (skillEntries.length === 0) {
    console.error('No bundled skills found in @ericdisero/aurora-shared — broken build?')
    process.exit(1)
  }

  const target = opts.global
    ? join(homedir(), '.claude', 'skills')
    : join(process.cwd(), '.claude', 'skills')

  let fresh = 0
  let updated = 0
  for (const [key, content] of skillEntries) {
    const name = frontmatterName(content, key)
    const dir = join(target, name)
    const isUpdate = existsSync(dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), content)
    if (isUpdate) {
      updated++
      console.log(`update  ${name}`)
    } else {
      fresh++
      console.log(`install ${name}`)
    }
  }

  console.log(`\nInstalled ${fresh + updated} skill(s) (${fresh} new, ${updated} updated) into ${target}`)
  console.log(`Restart Claude Code, then ask: 'what aurora skills do you have?' to verify.`)
}
