// Suno-provider client — sunoapi.org PRIMARY, kie.ai fallback (schema-identical
// /api/v1/* surfaces). Merged port of aurora's two proven implementations:
// src/main/providers/generation/suno-client.ts (app) + tools/bridge/lib/kie.ts
// (the reference impl, real-call verified 2026-06-10). Adds single-shot record
// fetchers so the background-job model can poll without blocking, and surfaces
// streamAudioUrl (listenable mid-generation, before the final file exists).

import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { getKieKey, getSunoBaseUrlOverride, getSunoKey } from '../config.js'

export const SUNOAPI_BASE_URL = 'https://api.sunoapi.org'
export const KIE_BASE_URL = 'https://api.kie.ai'

export interface SunoProvider {
  label: string
  baseUrl: string
  apiKey: string
  uploadStreamUrls: string[]
}

/** Resolve the active provider. Base URL: override → sunoapi.org when its key
 *  is set → kie.ai. Key: SUNO_API_KEY falling back to KIE_API_KEY. */
export function getProvider(): SunoProvider {
  const sunoKey = getSunoKey()
  const kieKey = getKieKey()
  const apiKey = sunoKey || kieKey
  if (!apiKey) {
    throw new Error(
      'No Suno provider key configured. Set SUNO_API_KEY (api.sunoapi.org, primary) or ' +
        'KIE_API_KEY (api.kie.ai, fallback) in your environment / MCP config env block, ' +
        'or run: aurora keys set --suno-api-key <key>'
    )
  }

  const baseUrl = getSunoBaseUrlOverride() || (sunoKey ? SUNOAPI_BASE_URL : KIE_BASE_URL)
  const isSunoApiOrg = baseUrl.includes('sunoapi.org')

  return {
    label: isSunoApiOrg ? 'sunoapi.org' : new URL(baseUrl).host,
    baseUrl,
    apiKey,
    uploadStreamUrls: isSunoApiOrg
      ? ['https://sunoapiorg.redpandaai.co/api/file-stream-upload', `${baseUrl}/api/file-stream-upload`]
      : ['https://kieai.redpandaai.co/api/file-stream-upload', `${baseUrl}/api/file-stream-upload`]
  }
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getProvider().apiKey}`
  }
}

const api = (path: string): string => `${getProvider().baseUrl}${path}`
export const host = (): string => getProvider().label

// Placeholder used only if the provider rejects a create that omits callBackUrl.
// We never receive this callback — completion is detected by polling.
const CALLBACK_PLACEHOLDER = 'https://example.com/aurora-mcp-callback'

const POLL_DELAY_MS = 5000
const MAX_POLL_ATTEMPTS = 120 // ~10 min ceiling

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const wireVocalGender = (v: 'male' | 'female'): 'm' | 'f' => (v === 'male' ? 'm' : 'f')

// ── Generation (from scratch) ───────────────────────────────────

export interface GenerationParams {
  prompt: string
  style?: string
  title?: string
  instrumental: boolean
  customMode: boolean
  model: string
  vocalGender?: 'male' | 'female'
  /** Comma-separated styles to exclude (the docs type this as ONE string). */
  negativeTags?: string
  /** 0..1 — style guidance intensity. */
  styleWeight?: number
  /** 0..1 — creative deviation / novelty. */
  weirdnessConstraint?: number
  /** 0..1 — input-audio influence (audio-conditioned tasks). */
  audioWeight?: number
  /** Persona id (Generate Persona) or a Suno Voice voiceId. Custom mode only. */
  personaId?: string
  /** 'style_persona' (default) | 'voice_persona' (voiceId on V5/V5_5). */
  personaModel?: 'style_persona' | 'voice_persona'
}

/** Append the shared optional knobs (full wire surface, param-table contract:
 *  docs/suno-param-surface.md) onto a create body. */
function applySharedKnobs(
  body: Record<string, unknown>,
  p: {
    vocalGender?: 'male' | 'female'
    negativeTags?: string
    styleWeight?: number
    weirdnessConstraint?: number
    audioWeight?: number
    personaId?: string
    personaModel?: 'style_persona' | 'voice_persona'
  }
): void {
  if (p.vocalGender) body.vocalGender = wireVocalGender(p.vocalGender)
  if (p.negativeTags) body.negativeTags = p.negativeTags
  if (p.styleWeight !== undefined) body.styleWeight = p.styleWeight
  if (p.weirdnessConstraint !== undefined) body.weirdnessConstraint = p.weirdnessConstraint
  if (p.audioWeight !== undefined) body.audioWeight = p.audioWeight
  if (p.personaId) {
    body.personaId = p.personaId
    body.personaModel = p.personaModel ?? 'style_persona'
  }
}

/** Submit a generation task. Returns the provider taskId. */
export async function createGeneration(params: GenerationParams): Promise<string> {
  const body: Record<string, unknown> = {
    prompt: params.prompt,
    customMode: params.customMode,
    instrumental: params.instrumental,
    model: params.model
  }
  if (params.style) body.style = params.style
  if (params.title) body.title = params.title
  applySharedKnobs(body, params)

  const res = await fetch(api('/api/v1/generate'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body)
  })
  const json = (await res.json()) as { code?: number; msg?: string; data?: { taskId?: string } }

  const taskId = json.data?.taskId
  if (!res.ok || !taskId) {
    throw new Error(
      `${host()} generate failed (HTTP ${res.status}): ${json.msg || 'no taskId returned'}`
    )
  }
  return taskId
}

// ── Sounds generation (samples / one-shots / loops; sunoapi.org only) ──

export interface SoundsParams {
  /** Max 500 chars per docs.sunoapi.org/suno-api/generate-sounds. */
  prompt: string
  /** Pitch lock, e.g. 'C', 'Cm', 'F#'. Default 'Any'. */
  soundKey?: string
  /** BPM 1-300; omit for auto. */
  soundTempo?: number
  soundLoop?: boolean
  /** Capture lyric subtitles alongside the audio. */
  grabLyrics?: boolean
}

/** Submit a Sounds Generation task. sunoapi.org ONLY — kie.ai does not expose
 *  the endpoint. Model locked to V5 by the docs. */
export async function createSoundsGeneration(params: SoundsParams): Promise<string> {
  const body: Record<string, unknown> = { prompt: params.prompt, model: 'V5' }
  if (params.soundKey) body.soundKey = params.soundKey
  if (params.soundTempo !== undefined) body.soundTempo = params.soundTempo
  if (params.soundLoop) body.soundLoop = true
  if (params.grabLyrics) body.grabLyrics = true

  const res = await fetch(api('/api/v1/generate/sounds'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body)
  })
  const json = (await res.json()) as {
    code?: number
    msg?: string
    data?: { taskId?: string; task_id?: string }
  }

  const taskId = json.data?.taskId ?? json.data?.task_id
  if (!res.ok || (json.code !== undefined && json.code !== 200) || !taskId) {
    throw new Error(
      `${host()} generate/sounds failed (HTTP ${res.status}, code ${json.code ?? 'n/a'}): ${
        json.msg || 'no taskId returned'
      }`
    )
  }
  return taskId
}

// ── Upload + cover (style transform) ────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff'
}

const UPLOAD_DIR = 'aurora-mcp'

/** Upload a local audio file via the provider's File Upload API. Returns the
 *  hosted URL for use as a cover reference (auto-deletes after ~3 days). */
export async function uploadAudioFile(filePath: string): Promise<string> {
  const { apiKey, uploadStreamUrls } = getProvider()
  const bytes = await readFile(filePath)
  const fileName = basename(filePath)
  const mime = MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream'

  let lastError: unknown
  for (const url of uploadStreamUrls) {
    try {
      const form = new FormData()
      form.append('uploadPath', UPLOAD_DIR)
      form.append('fileName', fileName)
      form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), fileName)

      const res = await fetch(url, {
        method: 'POST',
        // No Content-Type — fetch sets the multipart boundary itself.
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form
      })
      const json = (await res.json()) as {
        success?: boolean
        code?: number
        msg?: string
        data?: { downloadUrl?: string; download_url?: string; fileUrl?: string; file_url?: string }
      }

      const hosted =
        json.data?.downloadUrl ?? json.data?.download_url ?? json.data?.fileUrl ?? json.data?.file_url
      if (!res.ok || json.success === false || (json.code !== undefined && json.code !== 200) || !hosted) {
        throw new Error(
          `${host()} file upload failed (HTTP ${res.status}, code ${json.code ?? 'n/a'}): ${
            json.msg || 'no downloadUrl returned'
          }`
        )
      }
      return hosted
    } catch (err) {
      lastError = err // try the fallback host
    }
  }

  throw new Error(
    `${host()} file upload failed on all hosts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  )
}

export interface CoverParams {
  /** Hosted reference-audio URL from uploadAudioFile. */
  uploadUrl: string
  prompt: string
  style?: string
  title?: string
  instrumental: boolean
  customMode: boolean
  model: string
  vocalGender?: 'male' | 'female'
  negativeTags?: string
  /** 0..1 — how strongly the output hews to the input audio. */
  audioWeight?: number
  styleWeight?: number
  weirdnessConstraint?: number
  personaId?: string
  personaModel?: 'style_persona' | 'voice_persona'
}

/** Submit an upload-and-cover (style transform) task. Poll the returned taskId
 *  with the generation record fetchers (same record-info endpoint). */
export async function createCover(params: CoverParams): Promise<string> {
  const attempt = async (withCallback: boolean): Promise<string> => {
    const body: Record<string, unknown> = {
      uploadUrl: params.uploadUrl,
      prompt: params.prompt,
      customMode: params.customMode,
      instrumental: params.instrumental,
      model: params.model
    }
    if (params.style) body.style = params.style
    if (params.title) body.title = params.title
    applySharedKnobs(body, params)
    if (withCallback) body.callBackUrl = CALLBACK_PLACEHOLDER

    const res = await fetch(api('/api/v1/generate/upload-cover'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body)
    })
    const json = (await res.json()) as {
      code?: number
      msg?: string
      data?: { taskId?: string; task_id?: string }
    }

    const taskId = json.data?.taskId ?? json.data?.task_id
    if (!res.ok || (json.code !== undefined && json.code !== 200) || !taskId) {
      throw new Error(
        `${host()} upload-cover failed (HTTP ${res.status}, code ${json.code ?? 'n/a'}): ${
          json.msg || 'no taskId returned'
        }`
      )
    }
    return taskId
  }

  try {
    return await attempt(false)
  } catch {
    return attempt(true)
  }
}

// ── Layering endpoints (add-vocals / add-instrumental) ──────────
// Both condition on an uploaded audio file and poll the same record-info as
// generate/cover. Param shapes: docs/suno-param-surface.md (verified 2026-06-10).

export interface AddVocalsParams {
  /** Hosted instrumental URL from uploadAudioFile. */
  uploadUrl: string
  /** Vocal content + stylistic direction (lyrics-style text works). */
  prompt: string
  /** Genre / vocal approach, e.g. 'epic film choir, massed choral harmonies'. */
  style: string
  /** Track title (≤100 chars). */
  title: string
  /** Vocal styles to exclude, ONE comma-separated string (required by the docs). */
  negativeTags: string
  vocalGender?: 'male' | 'female'
  styleWeight?: number
  weirdnessConstraint?: number
  audioWeight?: number
  /** V4_5PLUS (default) | V5 | V5_5 — this endpoint supports only these three. */
  model?: string
}

/** Submit an add-vocals task: generates vocals over the uploaded instrumental,
 *  harmonized with it. Poll with the generation record fetchers. */
export async function createAddVocals(params: AddVocalsParams): Promise<string> {
  const attempt = async (withCallback: boolean): Promise<string> => {
    const body: Record<string, unknown> = {
      uploadUrl: params.uploadUrl,
      prompt: params.prompt,
      style: params.style,
      title: params.title,
      negativeTags: params.negativeTags,
      model: params.model ?? 'V4_5PLUS'
    }
    applySharedKnobs(body, { ...params, negativeTags: undefined })
    if (withCallback) body.callBackUrl = CALLBACK_PLACEHOLDER

    const res = await fetch(api('/api/v1/generate/add-vocals'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body)
    })
    const json = (await res.json()) as {
      code?: number
      msg?: string
      data?: { taskId?: string; task_id?: string }
    }
    const taskId = json.data?.taskId ?? json.data?.task_id
    if (!res.ok || (json.code !== undefined && json.code !== 200) || !taskId) {
      throw new Error(
        `${host()} add-vocals failed (HTTP ${res.status}, code ${json.code ?? 'n/a'}): ${
          json.msg || 'no taskId returned'
        }`
      )
    }
    return taskId
  }

  try {
    return await attempt(false)
  } catch {
    return attempt(true)
  }
}

export interface AddInstrumentalParams {
  /** Hosted audio URL (usually vocals or a stem) from uploadAudioFile. */
  uploadUrl: string
  /** Track title (≤100 chars). */
  title: string
  /** Desired instrumental style/mood/instruments — this endpoint names the field
   *  `tags`, NOT `style`. */
  tags: string
  /** Styles/instruments to exclude, ONE comma-separated string. */
  negativeTags: string
  vocalGender?: 'male' | 'female'
  styleWeight?: number
  weirdnessConstraint?: number
  audioWeight?: number
  /** V4_5PLUS (default) | V5 | V5_5. */
  model?: string
}

/** Submit an add-instrumental task: generates backing instrumentation
 *  complementary to the uploaded audio. Poll with the generation fetchers. */
export async function createAddInstrumental(params: AddInstrumentalParams): Promise<string> {
  const attempt = async (withCallback: boolean): Promise<string> => {
    const body: Record<string, unknown> = {
      uploadUrl: params.uploadUrl,
      title: params.title,
      tags: params.tags,
      negativeTags: params.negativeTags,
      model: params.model ?? 'V4_5PLUS'
    }
    applySharedKnobs(body, { ...params, negativeTags: undefined })
    if (withCallback) body.callBackUrl = CALLBACK_PLACEHOLDER

    const res = await fetch(api('/api/v1/generate/add-instrumental'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body)
    })
    const json = (await res.json()) as {
      code?: number
      msg?: string
      data?: { taskId?: string; task_id?: string }
    }
    const taskId = json.data?.taskId ?? json.data?.task_id
    if (!res.ok || (json.code !== undefined && json.code !== 200) || !taskId) {
      throw new Error(
        `${host()} add-instrumental failed (HTTP ${res.status}, code ${json.code ?? 'n/a'}): ${
          json.msg || 'no taskId returned'
        }`
      )
    }
    return taskId
  }

  try {
    return await attempt(false)
  } catch {
    return attempt(true)
  }
}

// ── Record polling (shared by generate / sounds / cover) ────────

export interface PolledVariation {
  /** Per-variation audio id — the WAV-conversion stage needs it. */
  id?: string
  audioUrl?: string
  /** Listenable mid-generation, before audioUrl exists. Expires server-side —
   *  never persist; use for instant preview only. */
  streamAudioUrl?: string
  title?: string
  duration?: number
}

export interface GenerationRecord {
  /** PENDING / TEXT_SUCCESS / FIRST_SUCCESS / SUCCESS / *_FAILED /
   *  CALLBACK_EXCEPTION / SENSITIVE_WORD_ERROR */
  status: string
  variations: PolledVariation[]
}

/** ONE record-info fetch (no waiting). The background-job model's poll unit. */
export async function fetchGenerationRecord(taskId: string): Promise<GenerationRecord> {
  const res = await fetch(
    `${api('/api/v1/generate/record-info')}?taskId=${encodeURIComponent(taskId)}`,
    { headers: authHeaders() }
  )
  const info = (await res.json()) as {
    code?: number
    data?: {
      status?: string
      response?: {
        sunoData?: Array<{
          id?: string
          audioUrl?: string
          streamAudioUrl?: string
          title?: string
          duration?: number
        }>
      }
    }
  }
  const status = info.data?.status ?? 'PENDING'
  const variations = (info.data?.response?.sunoData ?? []).map((s) => ({
    id: s.id,
    audioUrl: s.audioUrl,
    streamAudioUrl: s.streamAudioUrl,
    title: s.title,
    duration: s.duration
  }))
  return { status, variations }
}

export function isGenerationFailure(status: string): boolean {
  return status.endsWith('FAILED') || status === 'CREATE_TASK_FAILED' || status === 'SENSITIVE_WORD_ERROR'
}

/** Blocking poll until the variations are ready (mirrors the app's pattern,
 *  including the CALLBACK_EXCEPTION grace window). */
export async function pollGenerationTask(
  taskId: string,
  onStatus?: (status: string) => void
): Promise<PolledVariation[]> {
  let terminalWithoutAudio = 0

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_DELAY_MS)

    let record: GenerationRecord
    try {
      record = await fetchGenerationRecord(taskId)
    } catch {
      continue // transient — keep polling
    }

    onStatus?.(record.status)

    if (record.status === 'SUCCESS' || record.status === 'CALLBACK_EXCEPTION') {
      const ready = record.variations.filter((v) => v.audioUrl)
      if (ready.length > 0) return ready
      if (record.status === 'SUCCESS') {
        throw new Error(`${host()} reported SUCCESS but returned no audio URLs`)
      }
      terminalWithoutAudio++
      if (terminalWithoutAudio >= 3) {
        throw new Error(`${host()} reported CALLBACK_EXCEPTION but returned no audio URLs`)
      }
      continue
    }

    if (isGenerationFailure(record.status)) {
      throw new Error(`${host()} generation failed with status: ${record.status}`)
    }
  }

  throw new Error(`${host()} generation timed out (exceeded ~10 min poll ceiling)`)
}

// ── WAV conversion ──────────────────────────────────────────────

/** Submit a WAV conversion for one variation. Returns the WAV task's own taskId. */
export async function createWavConversion(taskId: string, audioId: string): Promise<string> {
  const attempt = async (withCallback: boolean): Promise<string> => {
    const body: Record<string, unknown> = { taskId, audioId }
    if (withCallback) body.callBackUrl = CALLBACK_PLACEHOLDER

    const res = await fetch(api('/api/v1/wav/generate'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body)
    })
    const json = (await res.json()) as {
      code?: number
      msg?: string
      data?: { taskId?: string; task_id?: string }
    }

    const wavTaskId = json.data?.taskId ?? json.data?.task_id
    if (!res.ok || (json.code !== undefined && json.code !== 200) || !wavTaskId) {
      throw new Error(
        `${host()} wav/generate failed (HTTP ${res.status}, code ${json.code ?? 'n/a'}): ${
          json.msg || 'no taskId returned'
        }`
      )
    }
    return wavTaskId
  }

  try {
    return await attempt(false)
  } catch {
    return attempt(true)
  }
}

/** Blocking poll of wav/record-info until the WAV URL appears. Tolerant of
 *  shape drift (camel/snake, nested/flat). */
export async function pollWavConversion(wavTaskId: string): Promise<string> {
  let terminalWithoutUrl = 0

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_DELAY_MS)

    let json: {
      code?: number
      data?: {
        successFlag?: string
        status?: string
        errorCode?: number | string | null
        errorMessage?: string | null
        audioWavUrl?: string
        audio_wav_url?: string
        response?: { audioWavUrl?: string; audio_wav_url?: string }
      }
    }
    try {
      const res = await fetch(
        `${api('/api/v1/wav/record-info')}?taskId=${encodeURIComponent(wavTaskId)}`,
        { headers: authHeaders() }
      )
      json = (await res.json()) as typeof json
    } catch {
      continue
    }

    const d = json.data ?? {}
    const url = d.response?.audioWavUrl ?? d.response?.audio_wav_url ?? d.audioWavUrl ?? d.audio_wav_url
    if (typeof url === 'string' && url.length > 0) return url

    const flag = String(d.successFlag ?? d.status ?? 'PENDING')
    if (flag.endsWith('FAILED')) {
      throw new Error(
        `${host()} WAV conversion failed (${flag}): ${d.errorMessage || d.errorCode || 'no detail'}`
      )
    }
    if (flag === 'SUCCESS' || flag === 'CALLBACK_EXCEPTION') {
      terminalWithoutUrl++
      if (terminalWithoutUrl >= 3) {
        throw new Error(`${host()} WAV task reports ${flag} but no audioWavUrl returned`)
      }
    }
  }

  throw new Error(`${host()} WAV conversion timed out (exceeded ~10 min poll ceiling)`)
}

// ── Misc ────────────────────────────────────────────────────────

/** Download a URL to disk. Provider URLs expire server-side — always persist
 *  immediately. */
export async function downloadTo(url: string, destPath: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}): ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(destPath, buf)
}

/** Remaining credit balance — free call, doubles as the auth smoke test. */
export async function getRemainingCredits(): Promise<number> {
  const res = await fetch(api('/api/v1/generate/credit'), { headers: authHeaders() })
  const json = (await res.json()) as { code?: number; msg?: string; data?: number }
  if (!res.ok || (json.code !== undefined && json.code !== 200) || typeof json.data !== 'number') {
    throw new Error(
      `${host()} credit check failed (HTTP ${res.status}, code ${json.code ?? 'n/a'}): ${
        json.msg || 'no numeric data field'
      }`
    )
  }
  return json.data
}
