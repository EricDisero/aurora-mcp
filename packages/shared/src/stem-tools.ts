import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join } from 'node:path'
import { getStemView } from './storage/stem-view.js'
import { decodeWavFile, encodeWavFloat32, type DecodedWav } from './audio/wav.js'
import { runFfmpeg } from './audio/ffmpeg.js'
import { amplitudeDb, measureLoudness } from './audio/loudness.js'
import type { LaneView } from './types.js'

export interface StemSelection {
  assetId: string; setKey: string; laneIds?: string[]; startSeconds?: number; endSeconds?: number
}
export interface StemExport extends StemSelection {
  mode: 'originals' | 'mix' | 'range'; outDir: string
  gains?: Record<string, number>; mutes?: string[]; solos?: string[]
}

function selectLanes(input: StemSelection, limit = Infinity): LaneView[] {
  const set = getStemView(input.assetId).sets.find((set) => set.key === input.setKey)
  if (!set) throw new Error(`Unknown setKey: ${input.setKey}. Read aurora_get_stem_view.`)
  if (input.laneIds && new Set(input.laneIds).size !== input.laneIds.length) throw new Error('laneIds must be unique')
  const lanes = input.laneIds ? input.laneIds.map((id) => {
    const lane = set.lanes.find((lane) => lane.laneId === id)
    if (!lane) throw new Error(`Unknown laneId in selected set: ${id}`)
    return lane
  }) : set.lanes
  if (!lanes.length || lanes.length > limit) throw new Error(`Lane selection must contain between 1 and ${limit} lanes per call`)
  for (const lane of lanes) if (!lane.available) throw new Error(`Lane file is missing on disk: ${lane.laneId} (${lane.path})`)
  return lanes
}

/** Decode WAV directly. Other containers/unsupported WAV codecs use local
 * ffmpeg, retaining rate/channels for measurements; exports resample only. */
async function decodeAudio(path: string, rate?: number): Promise<DecodedWav> {
  let direct: DecodedWav | undefined
  if (extname(path).toLowerCase() === '.wav') {
    try { direct = await decodeWavFile(path) } catch { /* Let ffmpeg decode other WAV codecs. */ }
  }
  if (direct && (rate === undefined || direct.sampleRate === rate)) return validateAudio(direct)
  const scratch = await mkdtemp(join(tmpdir(), 'aurora-stem-decode-'))
  try {
    const target = join(scratch, 'decoded.wav')
    await runFfmpeg(['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', path,
      '-map', '0:a:0', ...(rate ? ['-ar', String(rate)] : []), '-c:a', 'pcm_f32le', target])
    return validateAudio(await decodeWavFile(target))
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

function validateAudio(wav: DecodedWav): DecodedWav {
  if (!Number.isFinite(wav.sampleRate) || wav.sampleRate < 1 || !wav.frames || !wav.channels.length) throw new Error('Audio must have a positive sample rate and nonempty channels')
  for (const channel of wav.channels) for (const sample of channel) {
    if (!Number.isFinite(sample)) throw new Error('Audio must contain finite samples')
  }
  return wav
}

function range(input: StemSelection, frames: number, sampleRate: number) {
  const startSeconds = input.startSeconds ?? 0
  const endSeconds = input.endSeconds ?? frames / sampleRate
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) throw new Error('Range must have finite nonnegative startSeconds and endSeconds greater than startSeconds')
  const startFrame = Math.round(startSeconds * sampleRate)
  const endFrame = Math.round(endSeconds * sampleRate)
  if (startFrame >= frames || endFrame > frames || endFrame <= startFrame) throw new Error('Range must be nonempty and inside the audio duration')
  return { startSeconds: startFrame / sampleRate, endSeconds: endFrame / sampleRate,
    startFrame, endFrame, frames: endFrame - startFrame }
}

function trim(wav: DecodedWav, bounds: ReturnType<typeof range>): DecodedWav {
  return { sampleRate: wav.sampleRate, frames: bounds.frames,
    channels: wav.channels.map((channel) => channel.slice(bounds.startFrame, bounds.endFrame)) }
}

export async function getStemPeaks(input: StemSelection & { points: number }) {
  if (!Number.isInteger(input.points) || input.points < 1 || input.points > 2000) throw new Error('points must be an integer between 1 and 2000')
  const lanes = selectLanes(input, 16)
  const results = []
  for (const lane of lanes) {
    const wav = await decodeAudio(lane.path)
    const bounds = range(input, wav.frames, wav.sampleRate)
    const peaks: [number, number][] = []
    for (let point = 0; point < input.points; point++) {
      const start = bounds.startFrame + Math.floor(point * bounds.frames / input.points)
      const end = bounds.startFrame + Math.floor((point + 1) * bounds.frames / input.points)
      let min = Infinity, max = -Infinity
      // Empty bins repeat their nearest frame, keeping the requested shape.
      for (let frame = start; frame < Math.max(start + 1, end); frame++) {
        let sample = wav.channels[0][frame]
        for (const channel of wav.channels) {
          if (Math.abs(channel[frame]) > Math.abs(sample)) sample = channel[frame]
        }
        min = Math.min(min, sample); max = Math.max(max, sample)
      }
      peaks.push([min, max])
    }
    results.push({ laneId: lane.laneId, sampleRate: wav.sampleRate,
      durationSeconds: wav.frames / wav.sampleRate, measuredRange: bounds, peaks })
  }
  return { assetId: input.assetId, setKey: input.setKey, points: input.points, lanes: results }
}

export async function measureStems(input: StemSelection) {
  const results = []
  for (const lane of selectLanes(input)) {
    const wav = await decodeAudio(lane.path)
    const bounds = range(input, wav.frames, wav.sampleRate)
    results.push({ laneId: lane.laneId, sampleRate: wav.sampleRate,
      ...measureLoudness(trim(wav, bounds)), measuredRange: bounds })
  }
  return { assetId: input.assetId, setKey: input.setKey, lanes: results }
}

function safeName(value: string): string {
  const name = value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)
  return name && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name) ? name : `lane_${name}`
}

/** Exclusive create/copy closes the race between checking a name and writing. */
async function writeUnique(outDir: string, name: string, content: Buffer | { source: string }): Promise<string> {
  const extension = extname(name), base = basename(name, extension)
  for (let suffix = 0; ; suffix++) {
    const path = join(outDir, `${base}${suffix ? `-${suffix}` : ''}${extension}`)
    try {
      if (Buffer.isBuffer(content)) await writeFile(path, content, { flag: 'wx' })
      else await copyFile(content.source, path, constants.COPYFILE_EXCL)
      return path
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
}

export async function exportStems(input: StemExport, checkCancelled: () => void = () => {}) {
  if (!isAbsolute(input.outDir)) throw new Error('outDir must be absolute')
  const lanes = selectLanes(input)
  const controls = [...Object.keys(input.gains ?? {}), ...(input.mutes ?? []), ...(input.solos ?? [])]
  for (const id of controls) if (!lanes.some((lane) => lane.laneId === id)) throw new Error(`Unknown or unselected control laneId: ${id}`)
  if (input.mode !== 'mix' && controls.length) throw new Error('gains, mutes and solos must use mode mix; other modes preserve lane levels')
  if (input.mode === 'originals' && (input.startSeconds !== undefined || input.endSeconds !== undefined)) throw new Error('originals copies whole files; range timing requires mode range or mix')
  for (const gain of Object.values(input.gains ?? {})) if (!Number.isFinite(gain) || !Number.isFinite(10 ** (gain / 20))) throw new Error('Gain must produce a finite amplitude')
  const decoded = []
  for (const lane of lanes) {
    checkCancelled()
    decoded.push({ lane, wav: await decodeAudio(lane.path, input.mode === 'originals' ? undefined : 44100) })
  }
  const commonFrames = Math.max(...decoded.map(({ wav }) => wav.frames))
  const bounds = input.mode === 'originals' ? null : range(input, commonFrames, 44100)
  const channelCount = Math.max(...decoded.map(({ wav }) => wav.channels.length))
  if (input.mode === 'mix' && decoded.some(({ wav }) => wav.channels.length !== channelCount && wav.channels.length !== 1)) throw new Error('Mix requires matching channel counts or mono lanes (mono is duplicated)')
  const gainsApplied: Record<string, number> = {}
  const prepared = decoded.map(({ lane, wav }) => {
    const audible = input.mode !== 'mix' || ((input.solos?.length ?? 0) > 0 ? input.solos!.includes(lane.laneId) : !input.mutes?.includes(lane.laneId))
    const gainDb = input.mode === 'mix' ? input.gains?.[lane.laneId] ?? 0 : 0
    gainsApplied[lane.laneId] = gainDb
    const channels = bounds ? wav.channels.map((source) => {
      const result = new Float32Array(bounds.frames)
      result.set(source.subarray(bounds.startFrame, Math.min(bounds.endFrame, wav.frames)))
      return result
    }) : wav.channels
    return { lane, wav, channels, audible, gainDb }
  })
  let mixed: Float32Array[] | undefined
  let peak: number | null = null
  if (input.mode === 'mix') {
    const accumulators = Array.from({ length: channelCount }, () => new Float64Array(bounds!.frames))
    for (const item of prepared) if (item.audible) {
      const gain = 10 ** (item.gainDb / 20)
      for (let channel = 0; channel < channelCount; channel++) {
        const source = item.channels[channel] ?? item.channels[0]
        for (let frame = 0; frame < bounds!.frames; frame++) accumulators[channel][frame] += source[frame] * gain
      }
    }
    mixed = accumulators.map((channel) => Float32Array.from(channel))
    peak = 0
    for (const channel of mixed) for (const sample of channel) {
      if (!Number.isFinite(sample)) throw new Error('Mix must fit finite float32 samples; reduce gains')
      peak = Math.max(peak, Math.abs(sample))
    }
  }
  checkCancelled()
  await mkdir(input.outDir, { recursive: true })
  const paths: string[] = []
  const outputLanes = []
  if (mixed) paths.push(await writeUnique(input.outDir, 'mix.wav', encodeWavFloat32(mixed, 44100)))
  for (const item of prepared) {
    checkCancelled()
    const path = mixed ? paths[0] : await writeUnique(input.outDir,
      `${safeName(item.lane.stemKey)}${input.mode === 'range' ? '-range.wav' : extname(item.lane.path) || '.audio'}`,
      input.mode === 'originals' ? { source: item.lane.path } : encodeWavFloat32(item.channels, 44100))
    if (!mixed) paths.push(path)
    outputLanes.push({ laneId: item.lane.laneId, stemKey: item.lane.stemKey, label: item.lane.label,
      sourcePath: item.lane.path, path, audible: item.audible, gainDb: item.gainDb,
      sampleRate: input.mode === 'originals' ? item.wav.sampleRate : 44100,
      frames: input.mode === 'originals' ? item.wav.frames : bounds!.frames })
  }
  const manifest = { mode: input.mode, assetId: input.assetId, setKey: input.setKey,
    lanes: outputLanes, range: bounds, gainsApplied,
    sampleRate: input.mode === 'originals' ? null : 44100,
    frames: bounds?.frames ?? null, paths, peak, peakDbfs: peak === null ? null : amplitudeDb(peak),
    clipping: peak !== null && peak > 1 }
  checkCancelled()
  const manifestPath = await writeUnique(input.outDir, 'stem-export.json', Buffer.from(JSON.stringify(manifest, null, 2)))
  return { manifest, manifestPath }
}
