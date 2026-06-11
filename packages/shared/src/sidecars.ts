// Python sidecar spawns (RVC vocal upscale + MIDI rip) — mirrors aurora's
// resolve/spawn pattern (src/main/rvc/upscale.ts, src/main/midi/rip.ts) without
// Electron. The sidecars live in the aurora repo (dev) or the installed app's
// resources (packaged); neither ships in this npm package. Resolution order:
//   1. AURORA_RVC_SIDECAR / AURORA_MIDI_SIDECAR — direct path to the exe
//   2. AURORA_REPO/<sidecar>/dist/<exe>           (frozen dev build)
//   3. AURORA_REPO/<sidecar>/main.py via python   (dev, deps installed)
//   4. installed app resources (best-effort known install locations)
// Missing → a clear, actionable error (the sidecars also need their Python
// deps / PyInstaller freeze — see aurora/CLAUDE.md Status).

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

interface ResolvedSidecar {
  command: string
  baseArgs: string[]
}

function resolveSidecar(
  kind: 'rvc' | 'midi'
): { resolved: ResolvedSidecar | null; searched: string[] } {
  const dirName = kind === 'rvc' ? 'sidecar-rvc' : 'sidecar-midi'
  const exeName =
    (kind === 'rvc' ? 'aurora-rvc' : 'aurora-midi') + (process.platform === 'win32' ? '.exe' : '')
  const searched: string[] = []

  const direct = process.env[kind === 'rvc' ? 'AURORA_RVC_SIDECAR' : 'AURORA_MIDI_SIDECAR']
  if (direct) {
    searched.push(direct)
    if (existsSync(direct)) return { resolved: { command: direct, baseArgs: [] }, searched }
  }

  const repo = process.env.AURORA_REPO
  if (repo) {
    const frozen = join(repo, dirName, 'dist', exeName)
    searched.push(frozen)
    if (existsSync(frozen)) return { resolved: { command: frozen, baseArgs: [] }, searched }

    const mainPy = join(repo, dirName, 'main.py')
    searched.push(mainPy)
    if (existsSync(mainPy)) {
      const python = process.platform === 'win32' ? 'python' : 'python3'
      return { resolved: { command: python, baseArgs: [mainPy] }, searched }
    }
  }

  // Installed-app resources (packaged layouts).
  const installCandidates =
    process.platform === 'win32'
      ? [join(homedir(), 'AppData', 'Local', 'Programs', 'Aurora', 'resources', dirName, exeName)]
      : process.platform === 'darwin'
        ? [join('/Applications', 'Aurora.app', 'Contents', 'Resources', dirName, exeName)]
        : []
  for (const c of installCandidates) {
    searched.push(c)
    if (existsSync(c)) return { resolved: { command: c, baseArgs: [] }, searched }
  }

  return { resolved: null, searched }
}

function runSidecar(resolved: ResolvedSidecar, args: string[]): Promise<{ stderrTail: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolved.command, [...resolved.baseArgs, ...args], { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.stdout.on('data', () => {
      // JSON-lines progress — consumed silently in the MCP (blocking call).
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve({ stderrTail: stderr.slice(-2000) })
      else reject(new Error(`sidecar exited ${code}: ${stderr.slice(-2000)}`))
    })
  })
}

export interface RvcUpscaleParams {
  /** Input vocal WAV (typically the split's vocals stem). */
  inputPath: string
  /** Output WAV path. */
  outputPath: string
  /** Voice model: 'jb' (default) or 'purposeaudacity' (A/B alternate). */
  model?: string
  /** Optional pitch shift in semitones. */
  f0UpKey?: number
}

export async function runRvcUpscale(params: RvcUpscaleParams): Promise<string> {
  const { resolved, searched } = resolveSidecar('rvc')
  if (!resolved) {
    throw new Error(
      'RVC sidecar not found. Set AURORA_REPO to your aurora checkout (or AURORA_RVC_SIDECAR to the ' +
        `frozen exe). Searched: ${searched.join(' | ') || '(no hints set)'}. ` +
        'Note: the sidecar needs its Python deps installed (see aurora/sidecar-rvc/).'
    )
  }
  if (!existsSync(params.inputPath)) throw new Error(`Input not found: ${params.inputPath}`)
  await mkdir(dirname(params.outputPath), { recursive: true })

  const args = ['--in', params.inputPath, '--out', params.outputPath, '--model', params.model || 'jb']
  if (typeof params.f0UpKey === 'number') args.push('--f0-up-key', String(params.f0UpKey))

  await runSidecar(resolved, args)
  if (!existsSync(params.outputPath)) {
    throw new Error(`RVC sidecar finished but produced no output at ${params.outputPath}`)
  }
  return params.outputPath
}

export type MidiMode = 'poly' | 'mono' | 'auto'

export interface RipMidiParams {
  inputPath: string
  outputPath: string
  /** Force a transcription path, or auto-route from `instrument`. */
  mode: MidiMode
  instrument?: string
}

export async function runRipMidi(params: RipMidiParams): Promise<string> {
  const { resolved, searched } = resolveSidecar('midi')
  if (!resolved) {
    throw new Error(
      'MIDI sidecar not found. Set AURORA_REPO to your aurora checkout (or AURORA_MIDI_SIDECAR to the ' +
        `frozen exe). Searched: ${searched.join(' | ') || '(no hints set)'}. ` +
        'Note: the sidecar needs its Python 3.9 deps installed (see aurora/sidecar-midi/).'
    )
  }
  if (!existsSync(params.inputPath)) throw new Error(`Input not found: ${params.inputPath}`)
  await mkdir(dirname(params.outputPath), { recursive: true })

  const args = ['--in', params.inputPath, '--out', params.outputPath, '--mode', params.mode]
  if (params.instrument) args.push('--instrument', params.instrument)

  await runSidecar(resolved, args)
  if (!existsSync(params.outputPath)) {
    throw new Error(`MIDI sidecar finished but produced no .mid at ${params.outputPath}`)
  }
  return params.outputPath
}
