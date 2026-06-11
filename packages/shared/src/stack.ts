// Stack (minimal layer view) — file-level port. stack.json lives in the project
// folder (same shape the app's stackStore persists), and the export-bundle math
// is the Node port of stackStore.exportBundle: one 32-bit float WAV per audible
// lane, padded with leading silence to common timeline zero (sample-accurate
// offset rounding, gain baked in, muted/solo-excluded lanes skipped).

import { join, basename, extname } from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { v4 as uuidv4 } from 'uuid'
import { getProjectDirectory } from './storage/projects.js'
import { standardizeToWav } from './audio/ffmpeg.js'
import { decodeWavFile, encodeWavFloat32File } from './audio/wav.js'
import type { StackLane } from './types.js'

const SAMPLE_RATE = 44100

function stackPath(projectId: string): string {
  return join(getProjectDirectory(projectId), 'stack.json')
}

export async function loadStack(projectId: string): Promise<StackLane[]> {
  const file = stackPath(projectId)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as { lanes?: StackLane[] }
    return Array.isArray(parsed.lanes) ? parsed.lanes : []
  } catch {
    return []
  }
}

export async function saveStack(projectId: string, lanes: StackLane[]): Promise<void> {
  const dir = getProjectDirectory(projectId)
  await mkdir(dir, { recursive: true })
  await writeFile(stackPath(projectId), JSON.stringify({ lanes }, null, 2))
}

export async function addLane(
  projectId: string,
  lane: { name: string; path: string; sourceId?: string; color?: string; offsetSec?: number; gainDb?: number }
): Promise<StackLane> {
  if (!existsSync(lane.path)) throw new Error(`Lane audio file not found: ${lane.path}`)
  const lanes = await loadStack(projectId)
  const full: StackLane = {
    id: uuidv4(),
    sourceId: lane.sourceId,
    name: lane.name,
    path: lane.path,
    color: lane.color,
    gainDb: lane.gainDb ?? 0,
    mute: false,
    solo: false,
    offsetSec: Math.max(0, lane.offsetSec ?? 0)
  }
  lanes.push(full)
  await saveStack(projectId, lanes)
  return full
}

export async function updateLane(
  projectId: string,
  laneId: string,
  patch: Partial<Pick<StackLane, 'offsetSec' | 'gainDb' | 'mute' | 'solo' | 'name'>>
): Promise<StackLane> {
  const lanes = await loadStack(projectId)
  const lane = lanes.find((l) => l.id === laneId)
  if (!lane) throw new Error(`Lane not found: ${laneId}`)
  if (patch.offsetSec !== undefined) lane.offsetSec = Math.max(0, patch.offsetSec)
  if (patch.gainDb !== undefined) lane.gainDb = patch.gainDb
  if (patch.mute !== undefined) lane.mute = patch.mute
  if (patch.solo !== undefined) lane.solo = patch.solo
  if (patch.name !== undefined) lane.name = patch.name
  await saveStack(projectId, lanes)
  return lane
}

export async function removeLane(projectId: string, laneId: string): Promise<void> {
  const lanes = await loadStack(projectId)
  await saveStack(
    projectId,
    lanes.filter((l) => l.id !== laneId)
  )
}

function dbToLin(db: number): number {
  return Math.pow(10, db / 20)
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'lane'
}

/** Export one padded 32f WAV per audible lane into <project>/stack-export/.
 *  Non-WAV / non-44.1k lanes are standardized first (the renderer's
 *  decodeAudioData resamples to the 44.1k context; ffmpeg does it here). */
export async function exportStackBundle(projectId: string): Promise<string[]> {
  const lanes = await loadStack(projectId)
  if (lanes.length === 0) throw new Error('Stack is empty — add lanes before exporting.')

  const anySolo = lanes.some((l) => l.solo)
  const audible = lanes.filter((l) => !(l.mute || (anySolo && !l.solo)))
  if (audible.length === 0) throw new Error('No audible lanes (everything muted or solo-excluded).')

  const exportDir = join(getProjectDirectory(projectId), 'stack-export')
  await mkdir(exportDir, { recursive: true })

  const paths: string[] = []
  const cleanups: string[] = []
  try {
    for (const lane of audible) {
      if (!existsSync(lane.path)) {
        throw new Error(`Lane "${lane.name}" points at a missing file: ${lane.path}`)
      }

      let wavSource = lane.path
      if (extname(lane.path).toLowerCase() !== '.wav') {
        wavSource = join(tmpdir(), `aurora-stack-${uuidv4()}.wav`)
        await standardizeToWav(lane.path, wavSource)
        cleanups.push(wavSource)
      }

      let decoded = await decodeWavFile(wavSource)
      if (decoded.sampleRate !== SAMPLE_RATE) {
        const resampled = join(tmpdir(), `aurora-stack-${uuidv4()}.wav`)
        await standardizeToWav(wavSource, resampled)
        cleanups.push(resampled)
        decoded = await decodeWavFile(resampled)
      }

      const offsetSamples = Math.round(lane.offsetSec * decoded.sampleRate)
      const totalLength = offsetSamples + decoded.frames
      const lin = dbToLin(lane.gainDb)

      const out = decoded.channels.map((src) => {
        const dst = new Float32Array(totalLength)
        for (let i = 0; i < src.length; i++) dst[offsetSamples + i] = src[i] * lin
        return dst
      })

      const dest = join(exportDir, `${sanitize(lane.name)}.wav`)
      await encodeWavFloat32File(dest, out, decoded.sampleRate)
      paths.push(dest)
    }
  } finally {
    for (const f of cleanups) await rm(f, { force: true }).catch(() => {})
  }

  return paths
}

/** Resolve a friendly lane name for an audio path (filename sans extension). */
export function laneNameFromPath(path: string): string {
  return basename(path, extname(path))
}
