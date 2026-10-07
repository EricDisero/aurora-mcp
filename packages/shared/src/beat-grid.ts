// Beat grid of an audio file. The core behind aurora_beat_grid: decode with the bundled ffmpeg, run Beat This!
// (CPJKU, ISMIR 2024) in the beat sidecar (aurora/sidecar-beats/beat_grid.py, its own venv), check the answer's shape.
// What each field means is documented in beat_grid.py; the op description tells agents how to read them.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { standardizeToWav } from './audio/ffmpeg.js'
import { resolveBeatsSidecar, runSidecar } from './sidecars.js'

export const beatGridSchema = z.object({
  engine: z.object({ name: z.string(), version: z.string(), checkpoint: z.string(), postprocessor: z.string(),
    device: z.string(), torch: z.string() }),
  durationS: z.number(),
  bpm: z.number(),
  bpmMedian: z.number(),
  firstDownbeatS: z.number().nullable(),
  firstDownbeatDetectedS: z.number().nullable(),
  meter: z.number().int().nullable(),
  meterConfidence: z.number(),
  fit: z.object({ periodS: z.number(), rmsMs: z.number(), maxAbsMs: z.number(), beats: z.number().int() }),
  beats: z.array(z.number()),
  downbeats: z.array(z.number()),
  kick: z.object({ bandHz: z.array(z.number()), beats: z.number().int(), hits: z.number().int(), contrast: z.number(),
    medianOffsetMs: z.number().nullable(), gridMedianOffsetMs: z.number().nullable(), gridSpreadMs: z.number().nullable(),
    reliable: z.boolean() }),
  hint: z.object({ bpm: z.number(), ratio: z.number(), relation: z.enum(['same', 'double', 'half', 'other']),
    slideMs: z.number() }).optional()
})
export type BeatGrid = z.infer<typeof beatGridSchema>

export interface BeatGridOptions {
  /** The tempo the file is expected to have; reported against in `hint`, never forced. */
  bpmHint?: number
  device?: 'auto' | 'cpu' | 'cuda'
  signal?: AbortSignal
}

function analysisFailure(message: string): Error {
  return Object.assign(new Error(message), { code: 'ANALYSIS_FAILED', retryable: false,
    nextAction: 'Check the file plays and holds at least a few seconds of rhythmic audio; analyse the full mix, not a stem without a pulse.' })
}

/** Beat, downbeat and tempo analysis of one audio file; any format the bundled ffmpeg reads. Free and local. */
export async function detectBeatGrid(inputPath: string, options: BeatGridOptions = {}): Promise<BeatGrid> {
  const sidecar = resolveBeatsSidecar()
  const scratch = await mkdtemp(join(tmpdir(), 'aurora-beats-'))
  try {
    const wav = join(scratch, 'input.wav')
    await standardizeToWav(inputPath, wav)
    const args = ['--in', wav, '--device', options.device ?? 'auto']
    if (options.bpmHint) args.push('--bpm-hint', String(options.bpmHint))
    let stdout: string
    try {
      ;({ stdout } = await runSidecar(sidecar, args, options.signal))
    } catch (error) {
      // The sidecar reports an analysis it could not make as {"error": ...} on stdout with exit code 2.
      const reported = lastJson((error as { stdout?: string }).stdout ?? '')
      if (reported && typeof reported.error === 'string') throw analysisFailure(reported.error)
      throw error
    }
    const result = lastJson(stdout)
    if (!result) throw analysisFailure(`The beat sidecar printed no result: ${stdout.slice(-300)}`)
    return beatGridSchema.parse(result)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** The last line of a sidecar's stdout that parses as a JSON object (libraries may print above it). */
function lastJson(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    try {
      const value: unknown = JSON.parse(line)
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    } catch { /* not the result line */ }
  }
  return null
}
