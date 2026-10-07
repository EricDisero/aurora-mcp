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
//
// The beat sidecar (Beat This!) is different: it runs in its own venv, made once by
// aurora/sidecar-beats/setup_venv.py, so it resolves a venv python plus a script
// (resolveBeatsSidecar below).

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ResolvedSidecar {
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

/** Run a sidecar to completion. stdout is JSON lines (progress, or the one result of the beat sidecar); a failed run
 *  rejects with the stderr tail and the stdout on `error.stdout`. An aborted signal kills the process. */
export function runSidecar(
  resolved: ResolvedSidecar,
  args: string[],
  signal?: AbortSignal
): Promise<{ stdout: string; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolved.command, [...resolved.baseArgs, ...args], { windowsHide: true, signal })
    let stdout = ''
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderrTail: stderr.slice(-2000) })
      else reject(Object.assign(new Error(`sidecar exited ${code}: ${stderr.slice(-2000)}`), { stdout }))
    })
  })
}

/** Python of Aurora's Beat This! environment: AURORA_BEATS_PYTHON, else the venv setup_venv.py makes in ~/.venvs
 *  (where Aurora's other engine environments live). */
export function beatsPythonPath(): string {
  return process.env.AURORA_BEATS_PYTHON ||
    join(homedir(), '.venvs', 'aurora-beats', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']))
}

/** The beat sidecar: the environment's python running aurora/sidecar-beats/beat_grid.py, found through AURORA_REPO or
 *  the app checkout beside this repo (as scripts/sync-separation.mjs does). Throws an error that carries the fix. */
export function resolveBeatsSidecar(): ResolvedSidecar {
  const python = beatsPythonPath()
  const scripts = [
    process.env.AURORA_REPO,
    fileURLToPath(new URL('../../../../aurora/', import.meta.url))
  ].filter((repo): repo is string => Boolean(repo)).map((repo) => join(repo, 'sidecar-beats', 'beat_grid.py'))
  const script = scripts.find((path) => existsSync(path))
  const notInstalled = (message: string, nextAction: string): Error =>
    Object.assign(new Error(message), { code: 'ENGINE_NOT_INSTALLED', retryable: false, nextAction })
  if (!script) {
    throw notInstalled(
      `Beat sidecar script not found. Searched: ${scripts.join(' | ') || '(none)'}.`,
      'Set AURORA_REPO to the aurora app checkout (it holds sidecar-beats/), then retry.'
    )
  }
  if (!existsSync(python)) {
    throw notInstalled(
      `Aurora's beat engine (Beat This!) is not installed: ${python} is missing.`,
      `Run once: python "${join(dirname(script), 'setup_venv.py')}" (needs uv or Python 3.10-3.12; downloads CPU torch and 81 MB of weights), then retry.`
    )
  }
  return { command: python, baseArgs: [script] }
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
