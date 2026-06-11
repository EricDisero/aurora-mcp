// ffmpeg operations — port of aurora tools/bridge/lib/ffmpeg-ops.ts +
// src/main/audio/ffmpeg.ts. Binary ships with this package via
// @ffmpeg-installer/ffmpeg (no Electron asar involved here).

import { spawn } from 'node:child_process'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'

const SAMPLE_RATE = 44100

export function getFfmpegPath(): string {
  return ffmpegInstaller.path
}

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(getFfmpegPath(), args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`))
    })
  })
}

/** Probe input duration in seconds via ffmpeg's `-i` banner (the installer
 *  ships no ffprobe). Returns null when no Duration line appears. */
export function probeDurationSeconds(inputPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(getFfmpegPath(), ['-hide_banner', '-i', inputPath], { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('error', () => resolve(null))
    proc.on('close', () => {
      const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr)
      if (!m) return resolve(null)
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]))
    })
  })
}

/** Standardize an arbitrary input to 44.1kHz stereo 32-bit float WAV — the
 *  single preprocessed format fed to MVSEP jobs and the `ee` phase-cancel
 *  reference (aurora's standardizeToWav, verbatim args). */
export async function standardizeToWav(inputPath: string, outputPath: string): Promise<void> {
  await runFfmpeg(['-y', '-i', inputPath, '-ac', '2', '-ar', '44100', '-c:a', 'pcm_f32le', outputPath])
}

let rubberbandCache: boolean | null = null

/** Whether the bundled ffmpeg build includes the rubberband filter. */
export async function hasRubberband(): Promise<boolean> {
  if (rubberbandCache !== null) return rubberbandCache
  rubberbandCache = await new Promise<boolean>((resolve) => {
    const proc = spawn(getFfmpegPath(), ['-hide_banner', '-filters'], { windowsHide: true })
    let out = ''
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString()
    })
    proc.on('error', () => resolve(false))
    proc.on('close', () => resolve(/\brubberband\b/.test(out)))
  })
  return rubberbandCache
}

/** Split a tempo factor into a chain of atempo filters (each must be in [0.5, 2]). */
export function atempoChain(factor: number): string {
  const parts: number[] = []
  let f = factor
  while (f > 2.0) {
    parts.push(2.0)
    f /= 2.0
  }
  while (f < 0.5) {
    parts.push(0.5)
    f /= 0.5
  }
  parts.push(f)
  return parts.map((p) => `atempo=${p.toFixed(6)}`).join(',')
}

export type PitchEngine = 'varispeed' | 'rubberband' | 'asetrate+atempo'
export type AudioFormat = 'wav' | 'mp3'

function codecArgs(format: AudioFormat): string[] {
  // wav mirrors the standardize format (44.1k float32); mp3 = 320k CBR.
  return format === 'wav' ? ['-c:a', 'pcm_f32le'] : ['-c:a', 'libmp3lame', '-b:a', '320k']
}

/** Pitch-shift by `semitones` (+/-). Output locked to 44.1kHz.
 *  Default: varispeed (tempo shifts with pitch). preserveTempo: rubberband
 *  when available, else asetrate + atempo correction. */
export async function pitchShift(
  inputPath: string,
  outputPath: string,
  semitones: number,
  preserveTempo: boolean,
  format: AudioFormat
): Promise<PitchEngine> {
  const ratio = 2 ** (semitones / 12)
  const shiftedRate = Math.round(SAMPLE_RATE * ratio)

  let engine: PitchEngine
  let filter: string
  if (!preserveTempo) {
    engine = 'varispeed'
    filter = `aresample=${SAMPLE_RATE},asetrate=${shiftedRate},aresample=${SAMPLE_RATE}`
  } else if (await hasRubberband()) {
    engine = 'rubberband'
    filter = `aresample=${SAMPLE_RATE},rubberband=pitch=${ratio.toFixed(8)}`
  } else {
    engine = 'asetrate+atempo'
    filter = `aresample=${SAMPLE_RATE},asetrate=${shiftedRate},aresample=${SAMPLE_RATE},${atempoChain(1 / ratio)}`
  }

  await runFfmpeg(['-y', '-i', inputPath, '-filter:a', filter, ...codecArgs(format), outputPath])
  return engine
}

/** Convert to mp3 (320k CBR), keeping source sample rate / channel layout. */
export async function convertToMp3(inputPath: string, outputPath: string): Promise<void> {
  await runFfmpeg(['-y', '-i', inputPath, ...codecArgs('mp3'), outputPath])
}
