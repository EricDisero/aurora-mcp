// Operations layer — the ONE place every Aurora agent tool is defined. Both the
// MCP server and the CLI register these as their tool / command surface
// (slates-mcp's single-registry rule, carried over). Every operation:
//   - has a stable string id (= the MCP tool name)
//   - has a Zod input schema (MCP tool definition AND CLI argument parsing)
//   - works directly against Aurora's userData DB + project folders (standalone
//     v1 — no running app required; renderer-bound mastering ops are deferred
//     to the app-integration follow-up)

import { join, extname, basename, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { getDbPath, getProjectsDirectory, getUserDataDir } from '../paths.js'
import { getMvsepKey, getSunoKey, getKieKey } from '../config.js'
import {
  createAddInstrumental,
  createAddVocals,
  createCover,
  createGeneration,
  createSoundsGeneration,
  createWavConversion,
  downloadTo,
  getRemainingCredits,
  host,
  pollWavConversion,
  uploadAudioFile
} from '../providers/suno.js'
import { getMvsepUserInfo } from '../providers/mvsep.js'
import {
  createProject,
  deleteProject,
  getProject,
  getProjectDirectory,
  listProjects,
  renameProject
} from '../storage/projects.js'
import {
  addFileAsset,
  deleteAsset,
  getAsset,
  insertAsset,
  listAssets,
  setAssetFavorite,
  setAssetTrack,
  updateAssetPath
} from '../storage/assets.js'
import {
  createTrack,
  deleteTrack,
  getTrack,
  getTrackDirectory,
  listTracks,
  renameTrack
} from '../storage/tracks.js'
import { getProjectStems, getStems } from '../storage/stems.js'
import { advanceJob, listJobs, loadJob, newJobManifest, saveJob, type JobManifest } from '../jobs.js'
import { createSplitJobs, prepareSplit } from '../split.js'
import { prepareExtract } from '../extract.js'
import {
  EXTRACT_BUNDLES,
  EXTRACT_INDIVIDUAL_STEMS,
  estimateExtractCost
} from '../extract-catalog.js'
import { probeDurationSeconds, standardizeToWav, convertToMp3, pitchShift } from '../audio/ffmpeg.js'
import { runRipMidi, runRvcUpscale } from '../sidecars.js'
import { SKILLS } from '../skills/content.js'
import type { ProjectAsset } from '../types.js'

export interface OperationResult {
  text: string
  data?: unknown
}

export interface Operation<I> {
  id: string
  description: string
  input: z.ZodType<I>
  run: (input: I) => Promise<OperationResult>
}

function ok(data: unknown, text?: string): OperationResult {
  return { text: text ?? JSON.stringify(data, null, 2), data }
}

// Latest Suno model (wire enum verified vs the sunoapi.org OpenAPI spec
// 2026-06-10: V4 | V4_5 | V4_5PLUS | V4_5ALL | V5 | V5_5). Sounds stays
// locked to V5 by its own docs.
const DEFAULT_GEN_MODEL = 'V5_5'
const MAX_COVER_REFERENCE_SECONDS = 8 * 60

const BACKGROUND_DESCRIBE =
  'Submit and return immediately with a jobId instead of blocking. Poll aurora_get_job_status ' +
  'every 10-20s. Status includes streamUrls you can hand the user to LISTEN mid-generation, ' +
  'before files land. Jobs survive process restarts (provider-side state).'

const landingTrackIdSchema = z
  .string()
  .optional()
  .describe(
    'Land the output in this track (project subfolder — aurora_list_tracks shows ids). Omit = project root'
  )

/** Validate a landing trackId: must exist and belong to the target project.
 *  Loud error (not silent root-landing) — agents should know they missed. */
function resolveLandingTrack(projectId: string, trackId?: string): string | null {
  if (!trackId) return null
  const track = getTrack(trackId)
  if (!track || track.projectId !== projectId) {
    throw new Error(
      `Track ${trackId} does not exist in project ${projectId} — call aurora_list_tracks for valid ids.`
    )
  }
  return trackId
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Blocking wrapper: advance the job every 5s up to ~12 min, then degrade
 *  gracefully to "still running" instead of erroring (MCP clients can time out
 *  long tool calls — the job itself is provider-side and loses nothing). */
async function awaitJob(m: JobManifest): Promise<JobManifest> {
  const MAX_WAIT_MS = 12 * 60 * 1000
  const start = Date.now()
  let current = m
  while (current.status === 'running' && Date.now() - start < MAX_WAIT_MS) {
    await sleep(5000)
    current = await advanceJob(current)
  }
  return current
}

function jobSummary(m: JobManifest): Record<string, unknown> {
  return {
    jobId: m.jobId,
    kind: m.kind,
    status: m.status,
    stage: m.stage,
    error: m.error,
    projectId: m.projectId,
    assetIds: m.assetIds,
    stems: m.stems,
    streamUrls: m.streamUrls && m.streamUrls.length > 0 ? m.streamUrls : undefined,
    lastProviderStatus: m.lastStatus,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt
  }
}

function jobText(m: JobManifest): string {
  if (m.status === 'done') {
    const assets = m.assetIds.length > 0 ? ` ${m.assetIds.length} asset(s): ${m.assetIds.join(', ')}.` : ''
    const stems = m.stems.length > 0 ? ` ${m.stems.length} stem(s) landed.` : ''
    return `Job ${m.jobId} complete.${assets}${stems} Files are on disk in the project folder.`
  }
  if (m.status === 'error') return `Job ${m.jobId} FAILED: ${m.error}`
  const stream =
    m.streamUrls && m.streamUrls.length > 0
      ? ` Stream preview available NOW (play these URLs for the user before files land): ${m.streamUrls.join(' , ')}`
      : ''
  return `Job ${m.jobId} still running — ${m.stage}.${stream} Poll aurora_get_job_status again in 10-20s.`
}

async function resolveProjectOrCreate(projectId: string | undefined, fallbackName: string): Promise<string> {
  if (projectId) {
    const p = getProject(projectId)
    if (!p) throw new Error(`Project not found: ${projectId}. Use aurora_list_projects.`)
    return p.id
  }
  const created = await createProject(fallbackName)
  return created.id
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'track'
}

/** Resolve an op input that may be an assetId or a raw file path. */
function resolveAudioInput(input: { assetId?: string; path?: string }): {
  path: string
  asset: ProjectAsset | null
} {
  if (input.assetId) {
    const asset = getAsset(input.assetId)
    if (!asset) throw new Error(`Asset not found: ${input.assetId}. Use aurora_list_assets.`)
    if (!existsSync(asset.path)) throw new Error(`Asset audio file is missing on disk: ${asset.path}`)
    return { path: asset.path, asset }
  }
  if (input.path) {
    if (!existsSync(input.path)) throw new Error(`File not found: ${input.path}`)
    return { path: input.path, asset: null }
  }
  throw new Error('Provide either assetId or path.')
}

// ── Identity / workspace ────────────────────────────────────────

const getCredits: Operation<Record<string, never>> = {
  id: 'aurora_get_credits',
  description:
    'Cloud balances: Suno provider credits (sunoapi.org/kie.ai) and MVSEP premium minutes. ' +
    'FREE call — run it before any paid generation or split, and after, to log real spend.',
  input: z.object({}).strict(),
  async run() {
    const result: Record<string, unknown> = {}
    try {
      result.sunoCredits = await getRemainingCredits()
      result.sunoProvider = host()
    } catch (err) {
      result.sunoError = err instanceof Error ? err.message : String(err)
    }
    if (getMvsepKey()) {
      try {
        const info = await getMvsepUserInfo()
        result.mvsepPremiumMinutes = info.premiumMinutes
        result.mvsepPremiumEnabled = info.premiumEnabled
      } catch (err) {
        result.mvsepError = err instanceof Error ? err.message : String(err)
      }
    } else {
      result.mvsepError = 'MVSEP_API_KEY not configured'
    }
    return ok(result)
  }
}

const getWorkspaceState: Operation<{ projectId?: string }> = {
  id: 'aurora_get_workspace_state',
  description:
    "Snapshot of the user's Aurora workspace: userData location, projects root, key status, " +
    'projects list, optional per-project assets+stems. Call once at the start of a session.',
  input: z.object({ projectId: z.string().optional() }),
  async run(input) {
    const projects = listProjects()
    let activeProject: unknown
    if (input.projectId) {
      const p = getProject(input.projectId)
      if (!p) throw new Error(`Project not found: ${input.projectId}`)
      activeProject = {
        ...p,
        directory: getProjectDirectory(p.id),
        tracks: listTracks(p.id),
        assets: listAssets(p.id),
        stems: getProjectStems(p.id)
      }
    }
    return ok({
      userData: getUserDataDir(),
      database: getDbPath(),
      projectsRoot: getProjectsDirectory(),
      keys: {
        suno: Boolean(getSunoKey() || getKieKey()),
        mvsep: Boolean(getMvsepKey())
      },
      projects,
      activeProject
    })
  }
}

// ── Projects ────────────────────────────────────────────────────

const createProjectOp: Operation<{ name: string }> = {
  id: 'aurora_create_project',
  description: 'Create a new Aurora project (a container of audio assets, with a human-readable folder on disk).',
  input: z.object({ name: z.string().min(1).describe('Project name, e.g. "Midnight Drive"') }),
  async run(input) {
    const project = await createProject(input.name)
    return ok({ project, directory: getProjectDirectory(project.id) })
  }
}

const listProjectsOp: Operation<Record<string, never>> = {
  id: 'aurora_list_projects',
  description: 'List every Aurora project (id, name, folder name, timestamps), newest first.',
  input: z.object({}).strict(),
  async run() {
    return ok({ projects: listProjects(), projectsRoot: getProjectsDirectory() })
  }
}

const renameProjectOp: Operation<{ projectId: string; name: string }> = {
  id: 'aurora_rename_project',
  description: 'Rename a project (display name only — the on-disk folder keeps its name).',
  input: z.object({ projectId: z.string(), name: z.string().min(1) }),
  async run(input) {
    return ok({ project: renameProject(input.projectId, input.name) })
  }
}

const deleteProjectOp: Operation<{ projectId: string; confirm?: boolean }> = {
  id: 'aurora_delete_project',
  description:
    'DELETE a project: its DB rows AND its entire folder on disk (all audio files). Irreversible. ' +
    'Requires confirm:true — ask the user first.',
  input: z.object({
    projectId: z.string(),
    confirm: z.boolean().optional().describe('Must be true. Confirm with the user before calling.')
  }),
  async run(input) {
    const project = getProject(input.projectId)
    if (!project) throw new Error(`Project not found: ${input.projectId}`)
    if (!input.confirm) {
      return ok(
        { wouldDelete: { project, directory: getProjectDirectory(project.id) } },
        `NOT deleted. This would remove project "${project.name}" and its entire folder ` +
          `${getProjectDirectory(project.id)} from disk. Re-call with confirm:true after the user agrees.`
      )
    }
    await deleteProject(input.projectId)
    return ok({ deleted: project.id }, `Deleted project "${project.name}" and its folder.`)
  }
}

const listAssetsOp: Operation<{ projectId: string }> = {
  id: 'aurora_list_assets',
  description:
    'All assets in a project (generations, covers, imports, references, masters) with their on-disk ' +
    'paths, plus every split stem grouped by source asset.',
  input: z.object({ projectId: z.string() }),
  async run(input) {
    const project = getProject(input.projectId)
    if (!project) throw new Error(`Project not found: ${input.projectId}`)
    const assets = listAssets(input.projectId)
    const stems = getProjectStems(input.projectId)
    const stemsByAsset: Record<string, typeof stems> = {}
    for (const s of stems) {
      ;(stemsByAsset[s.assetId] ??= []).push(s)
    }
    return ok({
      project,
      directory: getProjectDirectory(project.id),
      assets: assets.map((a) => ({ ...a, stems: stemsByAsset[a.id] ?? [] }))
    })
  }
}

// ── Tracks (project subfolders — one per song in a multi-track release) ──

const createTrackOp: Operation<{ projectId: string; name: string }> = {
  id: 'aurora_create_track',
  description:
    'Create a track inside a project — a real on-disk subfolder (one per song in a multi-track ' +
    'release, e.g. each cue of a soundtrack). Assets filed to a track nest under ' +
    '<project>/<track-slug>/; unfiled assets stay at the project root.',
  input: z.object({
    projectId: z.string(),
    name: z.string().min(1).describe('Track name, e.g. "Main Theme"')
  }),
  async run(input) {
    const track = await createTrack(input.projectId, input.name)
    return ok({ track, directory: getTrackDirectory(track.id) })
  }
}

const listTracksOp: Operation<{ projectId: string }> = {
  id: 'aurora_list_tracks',
  description:
    'List the tracks (subfolders) of a project with per-track asset counts. Assets with trackId ' +
    'null are unfiled (project root).',
  input: z.object({ projectId: z.string() }),
  async run(input) {
    const project = getProject(input.projectId)
    if (!project) throw new Error(`Project not found: ${input.projectId}`)
    const tracks = listTracks(input.projectId)
    const assets = listAssets(input.projectId)
    const countByTrack = new Map<string, number>()
    for (const a of assets) {
      const key = a.trackId ?? 'unfiled'
      countByTrack.set(key, (countByTrack.get(key) ?? 0) + 1)
    }
    return ok({
      project: { id: project.id, name: project.name },
      tracks: tracks.map((t) => ({
        ...t,
        directory: getTrackDirectory(t.id),
        assetCount: countByTrack.get(t.id) ?? 0
      })),
      unfiledCount: countByTrack.get('unfiled') ?? 0
    })
  }
}

const renameTrackOp: Operation<{ trackId: string; name: string }> = {
  id: 'aurora_rename_track',
  description: 'Rename a track (display name only — the on-disk subfolder keeps its slug).',
  input: z.object({ trackId: z.string(), name: z.string().min(1) }),
  async run(input) {
    if (!getTrack(input.trackId)) throw new Error(`Track not found: ${input.trackId}`)
    return ok({ track: renameTrack(input.trackId, input.name) })
  }
}

const deleteTrackOp: Operation<{ trackId: string }> = {
  id: 'aurora_delete_track',
  description:
    'Delete a track NON-destructively: every asset filed to it moves back to the project root ' +
    '(files relocate on disk, nothing is deleted), then the empty subfolder is removed.',
  input: z.object({ trackId: z.string() }),
  async run(input) {
    const track = getTrack(input.trackId)
    if (!track) throw new Error(`Track not found: ${input.trackId}`)
    await deleteTrack(input.trackId)
    return ok(
      { deleted: track.id },
      `Deleted track "${track.name}". Its assets moved back to the project root.`
    )
  }
}

const setAssetTrackOp: Operation<{ assetId: string; trackId: string | null }> = {
  id: 'aurora_set_asset_track',
  description:
    'File an asset to a track (or null = unfiled / project root). Physically moves the audio file ' +
    'plus its stems/ and extracts/ folders into the track subfolder and rewrites stored paths.',
  input: z.object({
    assetId: z.string(),
    trackId: z
      .string()
      .nullable()
      .describe('Target track id, or null to move the asset back to the project root')
  }),
  async run(input) {
    const asset = await setAssetTrack(input.assetId, input.trackId)
    return ok({ asset })
  }
}

const favoriteAssetOp: Operation<{ assetId: string; favorite: boolean }> = {
  id: 'aurora_favorite_asset',
  description:
    "Set or clear an asset's persisted favorite flag (the Library's favorites-only filter keys off it).",
  input: z.object({ assetId: z.string(), favorite: z.boolean() }),
  async run(input) {
    const asset = setAssetFavorite(input.assetId, input.favorite)
    return ok({ asset })
  }
}

// ── Asset management ────────────────────────────────────────────

const importFileOp: Operation<{ projectId: string; trackId?: string; filePath: string }> = {
  id: 'aurora_import_file',
  description:
    "Copy an external audio file into a project as an 'import' asset (lands in <project>/imports/, " +
    "or the track's imports/ if trackId is given). Any asset can then be split, covered, or pitch-shifted.",
  input: z.object({
    projectId: z.string(),
    trackId: z.string().optional().describe('File the import into this track subfolder'),
    filePath: z.string().describe('Absolute path to the audio file to import')
  }),
  async run(input) {
    if (!existsSync(input.filePath)) throw new Error(`File not found: ${input.filePath}`)
    const asset = await addFileAsset({
      projectId: input.projectId,
      trackId: input.trackId ?? null,
      kind: 'import',
      filePath: input.filePath
    })
    return ok({ asset })
  }
}

const addReferenceOp: Operation<{ projectId: string; trackId?: string; filePath: string }> = {
  id: 'aurora_add_reference',
  description:
    "Copy an audio file into a project as a 'reference' asset (lands in <project>/references/ and " +
    "registers in the global reference library the mastering flow keys off). References can be split too.",
  input: z.object({
    projectId: z.string(),
    trackId: z.string().optional().describe('File the reference into this track subfolder'),
    filePath: z.string().describe('Absolute path to the reference audio file')
  }),
  async run(input) {
    if (!existsSync(input.filePath)) throw new Error(`File not found: ${input.filePath}`)
    const asset = await addFileAsset({
      projectId: input.projectId,
      trackId: input.trackId ?? null,
      kind: 'reference',
      filePath: input.filePath
    })
    return ok({ asset })
  }
}

const deleteAssetOp: Operation<{ assetId: string; confirm?: boolean }> = {
  id: 'aurora_delete_asset',
  description:
    'DELETE an asset: its DB row, its audio file on disk, its stems folder, and any linked reference ' +
    'row. Irreversible. Requires confirm:true — ask the user first.',
  input: z.object({
    assetId: z.string(),
    confirm: z.boolean().optional().describe('Must be true. Confirm with the user before calling.')
  }),
  async run(input) {
    const asset = getAsset(input.assetId)
    if (!asset) throw new Error(`Asset not found: ${input.assetId}`)
    if (!input.confirm) {
      return ok(
        { wouldDelete: asset },
        `NOT deleted. This would remove "${asset.name}" (${asset.path}) and its stems from disk. ` +
          'Re-call with confirm:true after the user agrees.'
      )
    }
    await deleteAsset(input.assetId)
    return ok({ deleted: asset.id }, `Deleted asset "${asset.name}".`)
  }
}

const fetchWavOp: Operation<{ assetId: string }> = {
  id: 'aurora_fetch_wav',
  description:
    'Upgrade a generation/cover asset from MP3 to provider WAV (uses the taskId+audioId stored at ' +
    'generation time; ~0.4 Suno credits per conversion). The asset re-points at the WAV; the MP3 stays on disk.',
  input: z.object({ assetId: z.string() }),
  async run(input) {
    const asset = getAsset(input.assetId)
    if (!asset) throw new Error(`Asset not found: ${input.assetId}`)
    const origin = (asset.origin ?? {}) as { taskId?: string; audioId?: string | null }
    if (!origin.taskId || !origin.audioId) {
      throw new Error(
        'This asset has no provider taskId/audioId in its origin metadata (probably an import, or a ' +
          'legacy generation) — the provider WAV conversion needs both. Use aurora_convert for a local ffmpeg WAV instead.'
      )
    }
    const wavTaskId = await createWavConversion(origin.taskId, origin.audioId)
    const wavUrl = await pollWavConversion(wavTaskId)
    const wavPath = join(dirname(asset.path), `${basename(asset.path, extname(asset.path))}.wav`)
    await downloadTo(wavUrl, wavPath)
    const updated = updateAssetPath(asset.id, wavPath)
    return ok({ asset: updated }, `WAV fetched: ${wavPath} (asset re-pointed; MP3 kept on disk).`)
  }
}

// ── Generation (long ops — background-capable) ──────────────────

// Shared knob schemas — the schema IS the agent's manual (param-table contract:
// docs/suno-param-surface.md, verified vs live docs 2026-06-10).
const styleWeightSchema = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe('0..1 — how hard the output follows the style text. ~0.55-0.75 for layering work')
const weirdnessSchema = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe('0..1 — creative deviation/novelty. Low (0.2-0.4) = predictable takes, high = surprises')
const audioWeightSchema = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe('0..1 — input-audio influence on audio-conditioned ops. 0.7-0.85 locks tempo/harmony to the upload')
const personaIdSchema = z
  .string()
  .optional()
  .describe('Persona id or Suno Voice voiceId — keeps a consistent vocal character across generations (custom mode only)')
const personaModelSchema = z
  .enum(['style_persona', 'voice_persona'])
  .optional()
  .describe('style_persona (default) | voice_persona (set when personaId is a Suno Voice voiceId, V5/V5_5 only)')

const generateOp: Operation<{
  prompt: string
  customMode?: boolean
  style?: string
  title?: string
  instrumental?: boolean
  model?: string
  vocalGender?: 'male' | 'female'
  negativeTags?: string
  styleWeight?: number
  weirdnessConstraint?: number
  audioWeight?: number
  personaId?: string
  personaModel?: 'style_persona' | 'voice_persona'
  projectId?: string
  trackId?: string
  background?: boolean
}> = {
  id: 'aurora_generate',
  description:
    'Generate a full music track via Suno (2 variations land as project assets, MP3 + WAV-upgradeable). ' +
    'ULTRA-CUSTOM by default: in custom mode (style + title set) the prompt is the EXACT sung lyrics — ' +
    'write real lyrics with section metatags like [Verse]/[Chorus]/[Choir]. Takes 1-3 minutes. ' +
    'PAID (Suno credits) — check aurora_get_credits first. ' +
    BACKGROUND_DESCRIBE,
  input: z.object({
    prompt: z
      .string()
      .describe(
        'Custom mode: the EXACT lyrics sung verbatim (≤5000 chars on V4_5+; supports [Verse]/[Chorus]/[Choir]/[Instrumental] metatags; ignored when instrumental). ' +
          'Non-custom mode: a ≤500-char track description — Suno writes its own lyrics'
      ),
    customMode: z
      .boolean()
      .optional()
      .describe(
        'true = full control (style + title REQUIRED, prompt = literal lyrics). false = description-only mode. ' +
          'Default: true when style or title is set. Prefer custom mode — it is the whole point of this surface'
      ),
    style: z
      .string()
      .optional()
      .describe('Music style text (≤1000 chars on V4_5+). Required in custom mode'),
    title: z.string().optional().describe('Track title (≤100 chars). Required in custom mode'),
    instrumental: z.boolean().optional().describe('Generate without vocals (default false)'),
    model: z
      .string()
      .optional()
      .describe(`V4 | V4_5 | V4_5PLUS | V4_5ALL | V5 | V5_5 (default ${DEFAULT_GEN_MODEL}; dots normalized)`),
    vocalGender: z.enum(['male', 'female']).optional(),
    negativeTags: z
      .string()
      .optional()
      .describe('Styles/instruments to exclude, ONE comma-separated string, e.g. "drums, percussion, orchestra". More reliable than "no X" in the style text'),
    styleWeight: styleWeightSchema,
    weirdnessConstraint: weirdnessSchema,
    audioWeight: audioWeightSchema,
    personaId: personaIdSchema,
    personaModel: personaModelSchema,
    projectId: z.string().optional().describe('Target project (auto-created from the title/prompt when omitted)'),
    trackId: landingTrackIdSchema,
    background: z.boolean().optional().describe('Return a jobId immediately instead of waiting')
  }),
  async run(input) {
    const customMode = input.customMode ?? Boolean(input.style || input.title)
    if (customMode && (!input.style || !input.title)) {
      throw new Error('Custom mode requires BOTH style and title (lyrics go in prompt).')
    }
    if (!customMode && input.prompt.length > 500) {
      throw new Error(
        'Non-custom prompts cap at 500 chars (it is a description, not lyrics). For literal lyrics set customMode true + style + title.'
      )
    }
    const model = (input.model ?? DEFAULT_GEN_MODEL).replace(/\./g, '_')
    const baseName = input.title?.trim() || input.prompt.slice(0, 60).trim() || 'Generated track'
    const projectId = await resolveProjectOrCreate(input.projectId, baseName)
    const trackId = resolveLandingTrack(projectId, input.trackId)

    const taskId = await createGeneration({
      prompt: input.prompt,
      style: input.style,
      title: input.title,
      instrumental: input.instrumental ?? false,
      customMode,
      model,
      vocalGender: input.vocalGender,
      negativeTags: input.negativeTags,
      styleWeight: input.styleWeight,
      weirdnessConstraint: input.weirdnessConstraint,
      audioWeight: input.audioWeight,
      personaId: input.personaId,
      personaModel: input.personaModel
    })

    const manifest = newJobManifest(
      'generate',
      `gen-${uuidv4().slice(0, 8)}`,
      projectId,
      baseName,
      {
        prompt: input.prompt,
        customMode,
        style: input.style,
        title: input.title,
        instrumental: input.instrumental ?? false,
        model,
        vocalGender: input.vocalGender ?? null,
        negativeTags: input.negativeTags,
        styleWeight: input.styleWeight,
        weirdnessConstraint: input.weirdnessConstraint,
        audioWeight: input.audioWeight,
        personaId: input.personaId,
        personaModel: input.personaModel
      },
      { taskId }
    )
    manifest.trackId = trackId
    await saveJob(manifest)

    if (input.background) {
      return ok(jobSummary(manifest), jobText(manifest))
    }
    const finished = await awaitJob(manifest)
    return ok(jobSummary(finished), jobText(finished))
  }
}

const soundsOp: Operation<{
  prompt: string
  soundKey?: string
  tempo?: number
  loop?: boolean
  grabLyrics?: boolean
  projectId?: string
  trackId?: string
  background?: boolean
}> = {
  id: 'aurora_sounds',
  description:
    'Generate a sample / one-shot / loop via Suno Sounds (key + tempo lockable; 2 variations land as ' +
    'project assets). Fast (~20-30s) and cheap (~2.5 Suno credits). sunoapi.org only. ' +
    BACKGROUND_DESCRIBE,
  input: z.object({
    prompt: z.string().max(500).describe('Sound description, e.g. "huge cinematic braam, dark low brass"'),
    soundKey: z.string().optional().describe('Pitch lock: C..B major or Cm..Bm minor, sharps as C# (default Any)'),
    tempo: z.number().int().min(1).max(300).optional().describe('BPM lock; omit for auto'),
    loop: z.boolean().optional().describe('Generate as a loopable sound'),
    grabLyrics: z.boolean().optional().describe('Also capture lyric subtitles when the sound has vocals'),
    projectId: z.string().optional(),
    trackId: landingTrackIdSchema,
    background: z.boolean().optional()
  }),
  async run(input) {
    const baseName = input.prompt.slice(0, 60).trim() || 'Sound'
    const projectId = await resolveProjectOrCreate(input.projectId, baseName)
    const trackId = resolveLandingTrack(projectId, input.trackId)

    const taskId = await createSoundsGeneration({
      prompt: input.prompt,
      soundKey: input.soundKey,
      soundTempo: input.tempo,
      soundLoop: input.loop,
      grabLyrics: input.grabLyrics
    })

    const manifest = newJobManifest(
      'sounds',
      `snd-${uuidv4().slice(0, 8)}`,
      projectId,
      baseName,
      {
        prompt: input.prompt,
        instrumental: true,
        model: 'V5',
        soundKey: input.soundKey,
        soundTempo: input.tempo,
        soundLoop: input.loop ?? false,
        grabLyrics: input.grabLyrics ?? false
      },
      { taskId }
    )
    manifest.trackId = trackId
    await saveJob(manifest)

    if (input.background) {
      return ok(jobSummary(manifest), jobText(manifest))
    }
    const finished = await awaitJob(manifest)
    return ok(jobSummary(finished), jobText(finished))
  }
}

/** AIFF/FLAC → standardized WAV for upload (undocumented containers), then the
 *  provider File Upload API. The temp file is disposable the moment the upload
 *  returns — cleaned on every path (the leak here was a fresh-eyes review
 *  finding). Shared by cover / add-vocals / add-instrumental. */
async function uploadSourceAudio(sourcePath: string): Promise<string> {
  let tempUpload: string | null = null
  try {
    let uploadSource = sourcePath
    const ext = extname(sourcePath).toLowerCase()
    if (ext !== '.wav' && ext !== '.mp3') {
      const { tmpdir } = await import('node:os')
      tempUpload = join(tmpdir(), `aurora-upload-${Date.now()}.wav`)
      await standardizeToWav(sourcePath, tempUpload)
      uploadSource = tempUpload
    }
    return await uploadAudioFile(uploadSource)
  } finally {
    if (tempUpload) {
      const { rm } = await import('node:fs/promises')
      await rm(tempUpload, { force: true }).catch(() => {})
    }
  }
}

/** Resolve a layering-op source to a local file path (asset or external). */
function resolveSourcePath(input: { sourceAssetId?: string; sourcePath?: string }): {
  sourcePath: string
  sourceAsset: ProjectAsset | null
} {
  const sourceAsset = input.sourceAssetId ? getAsset(input.sourceAssetId) : null
  if (input.sourceAssetId && !sourceAsset) throw new Error(`Asset not found: ${input.sourceAssetId}`)
  const sourcePath = sourceAsset?.path ?? input.sourcePath
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error('Source not found — pass sourceAssetId (a project asset) or sourcePath (a file).')
  }
  return { sourcePath, sourceAsset }
}

const coverOp: Operation<{
  sourceAssetId?: string
  sourcePath?: string
  prompt: string
  customMode?: boolean
  style?: string
  title?: string
  instrumental?: boolean
  model?: string
  vocalGender?: 'male' | 'female'
  negativeTags?: string
  audioWeight?: number
  styleWeight?: number
  weirdnessConstraint?: number
  personaId?: string
  personaModel?: 'style_persona' | 'voice_persona'
  projectId?: string
  trackId?: string
  background?: boolean
  fetchWav?: boolean
}> = {
  id: 'aurora_cover',
  description:
    'Cover a track (Suno upload-and-cover style transform): same musical content, new style. Source is a ' +
    'project asset or an external file (max 8 minutes). COVERS RE-RENDER EVERYTHING in the reference — to ' +
    'generate one complementary layer (e.g. a choir part), feed a stripped stem or bare melody render of ONLY ' +
    'the line to perform, NOT the full mix (full mix in = a choir performing your drums). Layering settings ' +
    'that lock structure while swapping timbre: audioWeight 0.7-0.85, styleWeight 0.55-0.75, ' +
    'weirdnessConstraint 0.2-0.4. 2 variations land as cover assets linked to the source. ' +
    'PAID (~12 Suno credits + ~0.4/WAV) — check aurora_get_credits first. ' +
    BACKGROUND_DESCRIBE,
  input: z.object({
    sourceAssetId: z.string().optional().describe('Project asset to transform'),
    sourcePath: z.string().optional().describe('OR an external audio file path'),
    prompt: z.string().describe('Custom mode: exact lyrics. Non-custom: what the cover should sound like (≤500 chars)'),
    customMode: z
      .boolean()
      .optional()
      .describe('true = style + title required, prompt = literal lyrics. Default: true when style or title is set'),
    style: z.string().optional().describe('Target style (custom mode needs BOTH style and title; ≤1000 chars on V4_5+)'),
    title: z.string().optional(),
    instrumental: z.boolean().optional(),
    model: z
      .string()
      .optional()
      .describe(`V4 | V4_5 | V4_5PLUS | V4_5ALL | V5 | V5_5 (default ${DEFAULT_GEN_MODEL}; V4_5ALL caps input at 1 min)`),
    vocalGender: z.enum(['male', 'female']).optional(),
    negativeTags: z.string().optional().describe('Styles/instruments to exclude, ONE comma-separated string'),
    audioWeight: z.number().min(0).max(1).optional().describe('0..1 — 0 = new style dominates, 1 = stay close to the source. 0.7-0.85 = structure locked, timbre swapped'),
    styleWeight: styleWeightSchema,
    weirdnessConstraint: weirdnessSchema,
    personaId: personaIdSchema,
    personaModel: personaModelSchema,
    projectId: z.string().optional(),
    trackId: landingTrackIdSchema,
    background: z.boolean().optional(),
    fetchWav: z
      .boolean()
      .optional()
      .describe('Blocking mode only: also fetch the provider WAV per variation (default true; ~0.4 credits each)')
  }),
  async run(input) {
    const sourceAsset = input.sourceAssetId ? getAsset(input.sourceAssetId) : null
    if (input.sourceAssetId && !sourceAsset) throw new Error(`Asset not found: ${input.sourceAssetId}`)
    const sourcePath = sourceAsset?.path ?? input.sourcePath
    if (!sourcePath || !existsSync(sourcePath)) {
      throw new Error('Cover source not found — pass sourceAssetId (a project asset) or sourcePath (a file).')
    }

    const customMode = input.customMode ?? Boolean(input.style || input.title)
    if (customMode && (!input.style || !input.title)) {
      throw new Error('Custom mode needs BOTH a style and a title (you set only one).')
    }
    const model = (input.model ?? DEFAULT_GEN_MODEL).replace(/\./g, '_')

    // 8-minute reference cap (pre-checked; the provider enforces it too).
    const duration = await probeDurationSeconds(sourcePath)
    if (duration !== null && duration > MAX_COVER_REFERENCE_SECONDS) {
      throw new Error(
        `Reference audio is ${Math.round(duration)}s — covers cap the input at 8 minutes. Export a shorter section.`
      )
    }

    const baseName = input.title?.trim() || `${basename(sourcePath, extname(sourcePath))} cover`.trim()
    const projectId = input.projectId
      ? (getProject(input.projectId)?.id ??
        (() => {
          throw new Error(`Project not found: ${input.projectId}`)
        })())
      : (sourceAsset?.projectId ?? (await createProject(baseName)).id)

    const trackId = resolveLandingTrack(projectId, input.trackId)
    const uploadUrl = await uploadSourceAudio(sourcePath)
    const taskId = await createCover({
      uploadUrl,
      prompt: input.prompt,
      style: input.style,
      title: input.title,
      instrumental: input.instrumental ?? false,
      customMode,
      model,
      vocalGender: input.vocalGender,
      negativeTags: input.negativeTags,
      audioWeight: input.audioWeight,
      styleWeight: input.styleWeight,
      weirdnessConstraint: input.weirdnessConstraint,
      personaId: input.personaId,
      personaModel: input.personaModel
    })

    const manifest = newJobManifest(
      'cover',
      `cov-${uuidv4().slice(0, 8)}`,
      projectId,
      baseName,
      {
        prompt: input.prompt,
        customMode,
        style: input.style,
        title: input.title,
        instrumental: input.instrumental ?? false,
        model,
        vocalGender: input.vocalGender ?? null,
        negativeTags: input.negativeTags,
        audioWeight: input.audioWeight,
        styleWeight: input.styleWeight,
        weirdnessConstraint: input.weirdnessConstraint,
        personaId: input.personaId,
        personaModel: input.personaModel
      },
      { taskId, sourceAssetId: sourceAsset?.id ?? null }
    )
    manifest.trackId = trackId
    await saveJob(manifest)

    if (input.background) {
      return ok(jobSummary(manifest), jobText(manifest))
    }

    const finished = await awaitJob(manifest)

    // Blocking-mode WAV stage (mirrors the app's runCover best-effort WAVs).
    const wavNotes: string[] = []
    if (finished.status === 'done' && (input.fetchWav ?? true)) {
      for (const assetId of finished.assetIds) {
        try {
          await fetchWavOp.run({ assetId })
          wavNotes.push(`${assetId}: WAV fetched`)
        } catch (err) {
          wavNotes.push(`${assetId}: WAV failed (${err instanceof Error ? err.message : err}) — MP3 kept; retry with aurora_fetch_wav`)
        }
      }
    }
    const summary = jobSummary(finished)
    if (wavNotes.length > 0) (summary as Record<string, unknown>).wavStage = wavNotes
    return ok(summary, `${jobText(finished)}${wavNotes.length > 0 ? ` WAV stage: ${wavNotes.join('; ')}` : ''}`)
  }
}

const addVocalsOp: Operation<{
  sourceAssetId?: string
  sourcePath?: string
  prompt: string
  style: string
  title: string
  negativeTags: string
  vocalGender?: 'male' | 'female'
  styleWeight?: number
  weirdnessConstraint?: number
  audioWeight?: number
  model?: string
  projectId?: string
  trackId?: string
  background?: boolean
  fetchWav?: boolean
}> = {
  id: 'aurora_add_vocals',
  description:
    'Layer AI vocals ON TOP of an instrumental (Suno add-vocals): upload a track, get vocals performed ' +
    'against its tempo/key/changes. THE op for adding a choir or vocal part to an existing production: ' +
    'feed a SIMPLIFIED bounce (harmonic skeleton + the melody to relate to — strip drums/dense ornament), ' +
    'audioWeight 0.7-0.85, choir-steering style + negativeTags, then aurora_split the result and keep ONLY ' +
    'the vocals stem to lay over the real production. Output is a full mix; the vocal stem is the deliverable. ' +
    'PAID (Suno credits) — check aurora_get_credits first. ' +
    BACKGROUND_DESCRIBE,
  input: z.object({
    sourceAssetId: z.string().optional().describe('Project asset to sing over'),
    sourcePath: z.string().optional().describe('OR an external audio file path'),
    prompt: z
      .string()
      .describe('Vocal content + direction — lyrics or syllables (e.g. Latin chant for choir) with [Choir]/[Harmony] metatags'),
    style: z
      .string()
      .describe('Vocal approach, e.g. "epic film choir, massed choral harmonies, latin chant" (this is what steers choir vs lead singer)'),
    title: z.string().max(100).describe('Track title (≤100 chars)'),
    negativeTags: z
      .string()
      .describe('Vocal styles to exclude, ONE comma-separated string, e.g. "lead singer, pop vocal, rap, spoken word, autotune"'),
    vocalGender: z.enum(['male', 'female']).optional(),
    styleWeight: styleWeightSchema,
    weirdnessConstraint: weirdnessSchema,
    audioWeight: audioWeightSchema,
    model: z.string().optional().describe('V4_5PLUS (default) | V5 | V5_5 — this endpoint supports only these'),
    projectId: z.string().optional(),
    trackId: landingTrackIdSchema,
    background: z.boolean().optional(),
    fetchWav: z.boolean().optional().describe('Blocking mode only: also fetch the provider WAV per variation (default true)')
  }),
  async run(input) {
    const { sourcePath, sourceAsset } = resolveSourcePath(input)
    const baseName = input.title.trim() || `${basename(sourcePath, extname(sourcePath))} vocals`
    const projectId = input.projectId
      ? (getProject(input.projectId)?.id ??
        (() => {
          throw new Error(`Project not found: ${input.projectId}`)
        })())
      : (sourceAsset?.projectId ?? (await createProject(baseName)).id)

    const trackId = resolveLandingTrack(projectId, input.trackId)
    const uploadUrl = await uploadSourceAudio(sourcePath)
    const taskId = await createAddVocals({
      uploadUrl,
      prompt: input.prompt,
      style: input.style,
      title: input.title,
      negativeTags: input.negativeTags,
      vocalGender: input.vocalGender,
      styleWeight: input.styleWeight,
      weirdnessConstraint: input.weirdnessConstraint,
      audioWeight: input.audioWeight,
      model: (input.model ?? 'V4_5PLUS').replace(/\./g, '_')
    })

    const manifest = newJobManifest(
      'add_vocals',
      `avo-${uuidv4().slice(0, 8)}`,
      projectId,
      baseName,
      {
        op: 'add_vocals',
        prompt: input.prompt,
        style: input.style,
        title: input.title,
        negativeTags: input.negativeTags,
        vocalGender: input.vocalGender ?? null,
        styleWeight: input.styleWeight,
        weirdnessConstraint: input.weirdnessConstraint,
        audioWeight: input.audioWeight,
        model: (input.model ?? 'V4_5PLUS').replace(/\./g, '_'),
        instrumental: false
      },
      { taskId, sourceAssetId: sourceAsset?.id ?? null }
    )
    manifest.trackId = trackId
    await saveJob(manifest)

    if (input.background) {
      return ok(jobSummary(manifest), jobText(manifest))
    }
    const finished = await awaitJob(manifest)

    const wavNotes: string[] = []
    if (finished.status === 'done' && (input.fetchWav ?? true)) {
      for (const assetId of finished.assetIds) {
        try {
          await fetchWavOp.run({ assetId })
          wavNotes.push(`${assetId}: WAV fetched`)
        } catch (err) {
          wavNotes.push(`${assetId}: WAV failed (${err instanceof Error ? err.message : err}) — MP3 kept; retry with aurora_fetch_wav`)
        }
      }
    }
    const summary = jobSummary(finished)
    if (wavNotes.length > 0) (summary as Record<string, unknown>).wavStage = wavNotes
    return ok(
      summary,
      `${jobText(finished)}${wavNotes.length > 0 ? ` WAV stage: ${wavNotes.join('; ')}` : ''}` +
        (finished.status === 'done'
          ? ' Next for layering: aurora_split the result and keep the vocals stem.'
          : '')
    )
  }
}

const addInstrumentalOp: Operation<{
  sourceAssetId?: string
  sourcePath?: string
  title: string
  tags: string
  negativeTags: string
  vocalGender?: 'male' | 'female'
  styleWeight?: number
  weirdnessConstraint?: number
  audioWeight?: number
  model?: string
  projectId?: string
  trackId?: string
  background?: boolean
  fetchWav?: boolean
}> = {
  id: 'aurora_add_instrumental',
  description:
    'Generate backing instrumentation complementary to an uploaded audio (Suno add-instrumental — the ' +
    'inverse of aurora_add_vocals; input is usually a vocal or a melodic stem). Output is a full mix ' +
    'conditioned on the upload; split it to extract the new layers. PAID (Suno credits) — check ' +
    'aurora_get_credits first. ' +
    BACKGROUND_DESCRIBE,
  input: z.object({
    sourceAssetId: z.string().optional().describe('Project asset to build instrumentation around'),
    sourcePath: z.string().optional().describe('OR an external audio file path'),
    title: z.string().max(100).describe('Track title (≤100 chars)'),
    tags: z
      .string()
      .describe('Desired instrumental style/mood/instruments (this endpoint names the field tags, comma-separated)'),
    negativeTags: z.string().describe('Styles/instruments to exclude, ONE comma-separated string'),
    vocalGender: z.enum(['male', 'female']).optional(),
    styleWeight: styleWeightSchema,
    weirdnessConstraint: weirdnessSchema,
    audioWeight: audioWeightSchema,
    model: z.string().optional().describe('V4_5PLUS (default) | V5 | V5_5 — this endpoint supports only these'),
    projectId: z.string().optional(),
    trackId: landingTrackIdSchema,
    background: z.boolean().optional(),
    fetchWav: z.boolean().optional().describe('Blocking mode only: also fetch the provider WAV per variation (default true)')
  }),
  async run(input) {
    const { sourcePath, sourceAsset } = resolveSourcePath(input)
    const baseName = input.title.trim() || `${basename(sourcePath, extname(sourcePath))} instrumental`
    const projectId = input.projectId
      ? (getProject(input.projectId)?.id ??
        (() => {
          throw new Error(`Project not found: ${input.projectId}`)
        })())
      : (sourceAsset?.projectId ?? (await createProject(baseName)).id)
    const trackId = resolveLandingTrack(projectId, input.trackId)

    const uploadUrl = await uploadSourceAudio(sourcePath)
    const taskId = await createAddInstrumental({
      uploadUrl,
      title: input.title,
      tags: input.tags,
      negativeTags: input.negativeTags,
      vocalGender: input.vocalGender,
      styleWeight: input.styleWeight,
      weirdnessConstraint: input.weirdnessConstraint,
      audioWeight: input.audioWeight,
      model: (input.model ?? 'V4_5PLUS').replace(/\./g, '_')
    })

    const manifest = newJobManifest(
      'add_instrumental',
      `ain-${uuidv4().slice(0, 8)}`,
      projectId,
      baseName,
      {
        op: 'add_instrumental',
        title: input.title,
        tags: input.tags,
        negativeTags: input.negativeTags,
        vocalGender: input.vocalGender ?? null,
        styleWeight: input.styleWeight,
        weirdnessConstraint: input.weirdnessConstraint,
        audioWeight: input.audioWeight,
        model: (input.model ?? 'V4_5PLUS').replace(/\./g, '_'),
        instrumental: true
      },
      { taskId, sourceAssetId: sourceAsset?.id ?? null }
    )
    manifest.trackId = trackId
    await saveJob(manifest)

    if (input.background) {
      return ok(jobSummary(manifest), jobText(manifest))
    }
    const finished = await awaitJob(manifest)

    const wavNotes: string[] = []
    if (finished.status === 'done' && (input.fetchWav ?? true)) {
      for (const assetId of finished.assetIds) {
        try {
          await fetchWavOp.run({ assetId })
          wavNotes.push(`${assetId}: WAV fetched`)
        } catch (err) {
          wavNotes.push(`${assetId}: WAV failed (${err instanceof Error ? err.message : err}) — MP3 kept; retry with aurora_fetch_wav`)
        }
      }
    }
    const summary = jobSummary(finished)
    if (wavNotes.length > 0) (summary as Record<string, unknown>).wavStage = wavNotes
    return ok(summary, `${jobText(finished)}${wavNotes.length > 0 ? ` WAV stage: ${wavNotes.join('; ')}` : ''}`)
  }
}

const splitOp: Operation<{ assetId: string; background?: boolean }> = {
  id: 'aurora_split',
  description:
    'Split ANY project asset into 7 stems (vocals, kick, snare, toms, hats, bass, everything-else) via ' +
    '3 MVSEP jobs + local phase-cancellation. Takes 3-5+ minutes. PAID (REAL MVSEP credits — do not ' +
    're-split an asset that already has stems; check aurora_list_assets first). Stems land ' +
    'PROGRESSIVELY as each MVSEP job finishes. ' +
    BACKGROUND_DESCRIBE,
  input: z.object({
    assetId: z.string().describe('The asset to split (generation, cover, import, or reference)'),
    background: z.boolean().optional().describe('Strongly recommended — splits often exceed blocking-call ceilings')
  }),
  async run(input) {
    const existing = getStems(input.assetId)
    if (existing.length >= 7) {
      return ok(
        { stems: existing },
        'This asset ALREADY has a full 7-stem split — returning the existing stems instead of spending ' +
          'MVSEP credits again. Delete the stems first if you really want a re-split.'
      )
    }

    const prep = await prepareSplit(input.assetId)
    const hashes = await createSplitJobs(prep.audioBytes)

    const manifest = newJobManifest(
      'split',
      `spl-${uuidv4().slice(0, 8)}`,
      prep.asset.projectId,
      prep.asset.name,
      { assetId: input.assetId },
      { assetId: input.assetId, stemsDir: prep.stemsDir, hashes }
    )
    manifest.stage = 'separating (0/3 jobs landed)'
    await saveJob(manifest)

    if (input.background) {
      return ok(jobSummary(manifest), jobText(manifest))
    }
    const finished = await awaitJob(manifest)
    return ok(jobSummary(finished), jobText(finished))
  }
}

const VOCAL_MODE_DESCRIBE =
  "lead_back = lead + backing vocals; male_female = male + female voices. Vocal stems come from the mode, never from the stems array"

const extractOp: Operation<{
  assetId: string
  stems?: string[]
  vocalMode?: 'lead_back' | 'male_female'
  includeReverb?: boolean
  estimateOnly?: boolean
  background?: boolean
}> = {
  id: 'aurora_extract',
  description:
    'The Sample Extractor: pull SPECIFIC instruments out of ANY asset via the per-instrument MVSEP ' +
    'catalog (~35 instruments + bundles). Everything Else is ALWAYS included free (local phase-cancel), ' +
    'so the parts sum back to the original. VARIABLE PAID COST: one MVSEP call per individual stem, but ' +
    'bundles count ONCE however many members you pick (drum kit = 6 stems for 1 call; lead+rhythm guitar ' +
    '= 1 call; vocal modes = 1 call; dereverb = 1 call). Call with estimateOnly=true FIRST to see the ' +
    'exact call plan before spending. 12-minute input cap. Results land in <project>/extracts/ + the ' +
    'extraction_stems table; detected musical key rides every row. Takes minutes per call (sequential). ' +
    BACKGROUND_DESCRIBE,
  input: z.object({
    assetId: z.string().describe('The asset to extract from (any kind)'),
    stems: z
      .array(z.string())
      .optional()
      .describe(
        'Non-vocal catalog stem ids. Bundles: drum_kick/drum_snare/drum_toms/drum_hihats/' +
          'drum_cymbals_crash/drum_cymbals_ride (one call), guitar_lead/guitar_rhythm (one call). ' +
          'Individuals: piano, digital_piano, organ, accordion, harpsichord, saxophone, flute, trumpet, ' +
          'trombone, french_horn, tuba, clarinet, oboe, bassoon, harmonica, guitar_acoustic, ' +
          'guitar_electric, mandolin, banjo, ukulele, harp, sitar, dobro, violin, viola, cello, ' +
          'double_bass, bells, congas, tambourine, marimba, glockenspiel, timpani, triangle, ' +
          'wind_chimes, bass, synth'
      ),
    vocalMode: z.enum(['lead_back', 'male_female']).optional().describe(VOCAL_MODE_DESCRIBE),
    includeReverb: z
      .boolean()
      .optional()
      .describe(
        'Dereverb the vocal first: adds a reverb-tail stem; with a vocalMode the bundle runs on the DRY ' +
          'vocal; alone it delivers dry vocal + reverb tail'
      ),
    estimateOnly: z
      .boolean()
      .optional()
      .describe('Return the call plan + cost estimate WITHOUT spending anything'),
    background: z.boolean().optional().describe('Strongly recommended — sequential calls take minutes each')
  }),
  async run(input) {
    const selection = {
      stems: input.stems ?? [],
      vocalSeparationType: input.vocalMode ?? null,
      includeReverb: input.includeReverb ?? false
    }

    // Validate selection ids early (clear error beats a silent no-op call plan).
    const known = new Set([
      ...Object.keys(EXTRACT_INDIVIDUAL_STEMS),
      ...EXTRACT_BUNDLES.drumsep.stems,
      ...EXTRACT_BUNDLES.lead_rhythm_guitar.stems
    ])
    const unknown = selection.stems.filter((s) => !known.has(s))
    if (unknown.length > 0) {
      throw new Error(`Unknown stem id(s): ${unknown.join(', ')}. See the stems param description for the catalog.`)
    }

    const asset = getAsset(input.assetId)
    if (!asset) throw new Error(`Asset not found: ${input.assetId}`)
    const duration = await probeDurationSeconds(asset.path)
    const estimate = estimateExtractCost(selection, duration ?? 60)

    if (input.estimateOnly) {
      return ok(
        {
          estimate,
          durationSeconds: duration,
          note: 'Nothing spent. Re-run without estimateOnly to fire the plan.'
        },
        `Plan: ${estimate.totalCalls} MVSEP call(s) on a ~${estimate.minuteMultiplier}-minute track. ` +
          `Bundles: ${estimate.breakdown.bundles.map((b) => b.bundleId).join(', ') || 'none'}. ` +
          `Individual: ${estimate.breakdown.individualStems.join(', ') || 'none'}. EE included free. Nothing spent.`
      )
    }

    const { asset: prepared, state } = await prepareExtract(input.assetId, selection)

    const manifest = newJobManifest(
      'extract',
      `ext-${uuidv4().slice(0, 8)}`,
      prepared.projectId,
      prepared.name,
      {
        assetId: input.assetId,
        stems: selection.stems,
        vocalMode: selection.vocalSeparationType,
        includeReverb: selection.includeReverb,
        plannedCalls: estimate.totalCalls
      },
      { assetId: input.assetId, extract: state }
    )
    manifest.stage = `planned ${state.calls.length} MVSEP call(s)`
    await saveJob(manifest)

    if (input.background) {
      const summary = jobSummary(manifest)
      ;(summary as Record<string, unknown>).estimate = estimate
      return ok(summary, `${jobText(manifest)} Plan: ${estimate.totalCalls} MVSEP call(s).`)
    }
    const finished = await awaitJob(manifest)
    const summary = jobSummary(finished)
    ;(summary as Record<string, unknown>).estimate = estimate
    if (finished.status === 'done' && finished.provider.extract?.detectedKey) {
      ;(summary as Record<string, unknown>).detectedKey = finished.provider.extract.detectedKey
    }
    return ok(summary, jobText(finished))
  }
}

const getJobStatusOp: Operation<{ jobId: string }> = {
  id: 'aurora_get_job_status',
  description:
    'Poll a background job (generate / sounds / cover / split). Advances the job: downloads and ' +
    'registers whatever the provider has finished since the last poll (split stems land progressively). ' +
    'Returns streamUrls for in-progress generations — playable immediately.',
  input: z.object({ jobId: z.string() }),
  async run(input) {
    const manifest = await loadJob(input.jobId)
    if (!manifest) throw new Error(`Job not found: ${input.jobId}. Use aurora_list_jobs.`)
    const advanced = manifest.status === 'running' ? await advanceJob(manifest) : manifest
    return ok(jobSummary(advanced), jobText(advanced))
  }
}

const listJobsOp: Operation<Record<string, never>> = {
  id: 'aurora_list_jobs',
  description: 'List all background jobs (newest first) with status and landed outputs.',
  input: z.object({}).strict(),
  async run() {
    const jobs = await listJobs()
    return ok({ jobs: jobs.map(jobSummary) })
  }
}

// ── Audio utilities (local ffmpeg — free) ───────────────────────

const pitchShiftOp: Operation<{
  assetId?: string
  path?: string
  semitones: number
  preserveTempo?: boolean
  format?: 'wav' | 'mp3'
}> = {
  id: 'aurora_pitch_shift',
  description:
    'Pitch-shift an asset or audio file by +/- semitones (local ffmpeg, FREE, output locked to 44.1kHz). ' +
    'Default varispeed (tempo shifts with pitch); preserveTempo keeps tempo constant. If the input was a ' +
    'project asset, the result registers as a new import asset in the same project.',
  input: z.object({
    assetId: z.string().optional(),
    path: z.string().optional().describe('OR an absolute file path'),
    semitones: z.number().describe('e.g. 3, -2, 0.5'),
    preserveTempo: z.boolean().optional(),
    format: z.enum(['wav', 'mp3']).optional().describe('Output format (default wav)')
  }),
  async run(input) {
    const { path, asset } = resolveAudioInput(input)
    const format = input.format ?? 'wav'
    const stem = basename(path, extname(path))
    const sign = input.semitones >= 0 ? '+' : ''
    const outPath = join(dirname(path), `${stem}${sign}${input.semitones}st.${format}`)

    const engine = await pitchShift(path, outPath, input.semitones, input.preserveTempo ?? false, format)

    let newAsset: ProjectAsset | null = null
    if (asset) {
      newAsset = insertAsset({
        projectId: asset.projectId,
        kind: 'import',
        name: basename(outPath, extname(outPath)),
        path: outPath,
        origin: { tool: 'pitch_shift', semitones: input.semitones, engine, sourceAssetId: asset.id },
        sourceAssetId: asset.id
      })
    }
    return ok({ outputPath: outPath, engine, asset: newAsset })
  }
}

const convertOp: Operation<{ assetId?: string; path?: string; to: 'wav' | 'mp3' }> = {
  id: 'aurora_convert',
  description:
    'Convert an asset or audio file to WAV (44.1kHz stereo float32) or MP3 (320k CBR) via local ffmpeg ' +
    '(FREE). If the input was a project asset, the result registers as a new import asset.',
  input: z.object({
    assetId: z.string().optional(),
    path: z.string().optional(),
    to: z.enum(['wav', 'mp3'])
  }),
  async run(input) {
    const { path, asset } = resolveAudioInput(input)
    const stem = basename(path, extname(path))
    const sameExt = extname(path).toLowerCase() === `.${input.to}`
    const outPath = join(dirname(path), `${stem}${sameExt ? '-converted' : ''}.${input.to}`)

    if (input.to === 'wav') await standardizeToWav(path, outPath)
    else await convertToMp3(path, outPath)

    let newAsset: ProjectAsset | null = null
    if (asset) {
      newAsset = insertAsset({
        projectId: asset.projectId,
        kind: 'import',
        name: basename(outPath, extname(outPath)),
        path: outPath,
        origin: { tool: 'convert', to: input.to, sourceAssetId: asset.id },
        sourceAssetId: asset.id
      })
    }
    return ok({ outputPath: outPath, asset: newAsset })
  }
}

// ── Sidecars (local Python — free, require the aurora repo) ─────

const rvcUpscaleOp: Operation<{
  assetId?: string
  path?: string
  stemType?: string
  model?: string
  f0UpKey?: number
}> = {
  id: 'aurora_rvc_upscale',
  description:
    "RVC vocal upscale (local Python sidecar — FREE, but needs the aurora repo + sidecar deps; set the " +
    'AURORA_REPO env var). Input: a vocals stem (assetId + stemType "vocals") or any WAV path. Output ' +
    'lands next to the input as <name>_upscaled.wav.',
  input: z.object({
    assetId: z.string().optional().describe('Asset whose vocals stem to upscale'),
    stemType: z.string().optional().describe('Stem to pick from the asset (default "vocals")'),
    path: z.string().optional().describe('OR a direct WAV path'),
    model: z.string().optional().describe("'jb' (default) or 'purposeaudacity'"),
    f0UpKey: z.number().optional().describe('Pitch shift in semitones (default 0)')
  }),
  async run(input) {
    let inputPath = input.path
    if (input.assetId) {
      const stems = getStems(input.assetId)
      const want = input.stemType ?? 'vocals'
      const stem = stems.find((s) => s.stemType === want)
      if (!stem) {
        throw new Error(
          `Asset ${input.assetId} has no "${want}" stem. Split it first (aurora_split) or pass a direct path.`
        )
      }
      inputPath = stem.path
    }
    if (!inputPath) throw new Error('Provide assetId (+stemType) or path.')

    const outPath = join(dirname(inputPath), `${basename(inputPath, extname(inputPath))}_upscaled.wav`)
    await runRvcUpscale({ inputPath, outputPath: outPath, model: input.model, f0UpKey: input.f0UpKey })
    return ok({ outputPath: outPath })
  }
}

const ripMidiOp: Operation<{
  assetId?: string
  stemType?: string
  path?: string
  mode?: 'poly' | 'mono' | 'auto'
  instrument?: string
}> = {
  id: 'aurora_rip_midi',
  description:
    'Rip MIDI from an audio stem or file (local Python sidecar — FREE, but needs the aurora repo + ' +
    'sidecar deps; set AURORA_REPO). drums→onset detection, mono→CREPE, poly→Basic Pitch. Output: <name>.mid ' +
    'next to the input.',
  input: z.object({
    assetId: z.string().optional(),
    stemType: z.string().optional().describe('Which stem of the asset (e.g. "bass", "kick")'),
    path: z.string().optional(),
    mode: z.enum(['poly', 'mono', 'auto']).optional().describe('Transcription path (default auto)'),
    instrument: z.string().optional().describe('Instrument hint for auto-routing, e.g. "bass", "kick"')
  }),
  async run(input) {
    let inputPath = input.path
    let instrument = input.instrument
    if (input.assetId) {
      const stems = getStems(input.assetId)
      if (!input.stemType) throw new Error('Pass stemType with assetId (e.g. "bass", "kick").')
      const stem = stems.find((s) => s.stemType === input.stemType)
      if (!stem) throw new Error(`Asset ${input.assetId} has no "${input.stemType}" stem.`)
      inputPath = stem.path
      instrument ??= input.stemType
    }
    if (!inputPath) throw new Error('Provide assetId+stemType or path.')

    const outPath = join(dirname(inputPath), `${basename(inputPath, extname(inputPath))}.mid`)
    await runRipMidi({ inputPath, outputPath: outPath, mode: input.mode ?? 'auto', instrument })
    return ok({ outputPath: outPath })
  }
}

// ── Skills delivery (MCP-only clients) ──────────────────────────

const getPromptingGuideOp: Operation<{ topic?: string }> = {
  id: 'aurora_get_prompting_guide',
  description:
    'Read a bundled Aurora skill/guide (workflow recipes, Suno prompting, cost discipline, stems). ' +
    'Call with no topic to list available guides. CLI users: `aurora install-skills` installs these ' +
    'into .claude/skills/ instead.',
  input: z.object({
    topic: z.string().optional().describe('Guide name (from the no-topic listing) or a keyword')
  }),
  async run(input) {
    const names = Object.keys(SKILLS)
    if (!input.topic) {
      return ok({ guides: names }, `Available guides:\n${names.join('\n')}\nCall again with topic:<name>.`)
    }
    const exact = SKILLS[input.topic]
    if (exact) return ok({ name: input.topic, content: exact }, exact)
    const fuzzy = names.find((n) => n.includes(input.topic!.toLowerCase()))
    if (fuzzy) return ok({ name: fuzzy, content: SKILLS[fuzzy] }, SKILLS[fuzzy])
    throw new Error(`No guide matching "${input.topic}". Available: ${names.join(', ')}`)
  }
}

// ── Registry ────────────────────────────────────────────────────

export const ALL_OPERATIONS: ReadonlyArray<Operation<unknown>> = [
  getCredits,
  getWorkspaceState,
  createProjectOp,
  listProjectsOp,
  renameProjectOp,
  deleteProjectOp,
  listAssetsOp,
  createTrackOp,
  listTracksOp,
  renameTrackOp,
  deleteTrackOp,
  setAssetTrackOp,
  favoriteAssetOp,
  importFileOp,
  addReferenceOp,
  deleteAssetOp,
  fetchWavOp,
  generateOp,
  soundsOp,
  coverOp,
  addVocalsOp,
  addInstrumentalOp,
  splitOp,
  extractOp,
  getJobStatusOp,
  listJobsOp,
  pitchShiftOp,
  convertOp,
  rvcUpscaleOp,
  ripMidiOp,
  getPromptingGuideOp
] as unknown as ReadonlyArray<Operation<unknown>>
