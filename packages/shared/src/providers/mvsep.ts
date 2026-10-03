import { randomUUID } from 'node:crypto'
import { requireMvsepKey } from '../config.js'
import type { JobError } from '../types.js'
import type { MvsepJobSpec, SeparationProvider, SeparationResult } from '../separation/contracts.js'

export const MVSEP_BASE_URL = 'https://mvsep.com'
const CREATE_URL = `${MVSEP_BASE_URL}/api/separation/create`
const GET_URL = `${MVSEP_BASE_URL}/api/separation/get`
const USER_URL = `${MVSEP_BASE_URL}/api/app/user`
const POLL_DELAY_MS = 5000
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function safeMessage(message: string): string {
  return message.replace(/https?:\/\/\S+/gi, '[redacted URL]')
    .replace(/(api_token|api_key|authorization)(["']?\s*[=:]\s*["']?)\S+/gi, '$1$2[redacted]')
}

export class MvsepError extends Error implements JobError {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly nextAction: string,
    public readonly stage?: string,
    public readonly httpStatus?: number
  ) {
    super(safeMessage(message))
    this.name = 'MvsepError'
  }
}

/** Normalize transport, identity and local landing errors without leaking signed URLs. */
export function separationError(error: unknown, stage: string = 'poll'): JobError {
  if (error instanceof MvsepError) {
    return { code: error.code, message: error.message, retryable: error.retryable,
      nextAction: error.nextAction, stage: error.stage ?? stage, httpStatus: error.httpStatus }
  }
  const message = safeMessage(error instanceof Error ? error.message : String(error))
  if (error instanceof Error && (error.name === 'OutputIdentityError' || /RIFF|WAVE|WAV format/i.test(message))) {
    return { code: 'OUTPUT_IDENTITY', message, retryable: false, stage,
      nextAction: 'Inspect the route and returned algorithm, keys and labels. Do not submit replacement paid work automatically.' }
  }
  const status = /HTTP (\d+)/.exec(message)?.[1]
  if (stage === 'landing' && (status === '404' || status === '410')) {
    return { code: 'MVSEP_RESULT_EXPIRED', message, retryable: false, stage,
      nextAction: 'Check the existing hash in MVSEP. A replacement spends credits and requires new authorization.' }
  }
  const retryable = error instanceof TypeError || /fetch|network|timeout|download|EAI_AGAIN|ECONN|EBUSY|EACCES|EIO|ENOSPC|SQLITE_BUSY|SQLITE_LOCKED/i.test(message)
  return { code: retryable ? 'MVSEP_NETWORK' : 'SEPARATION_FAILED', message, retryable, stage,
    nextAction: retryable ? 'Advance this same job again; keep its hash and do not submit another paid call.' : 'Inspect the failure and existing outputs before authorizing any replacement work.' }
}

type Body = {
  success?: boolean
  status?: string
  message?: string
  data?: { hash?: string; algorithm?: string; message?: string;
    files?: Array<{ url: string; download: string; type?: string }> }
}

/** The deadline covers both response headers and the response body. */
async function request(url: string, init: RequestInit, creating: boolean, secret?: string): Promise<{ res: Response; body: Body }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), creating ? 120_000 : 30_000)
  let response: Response | undefined
  try {
    response = await fetch(url, { ...init, signal: controller.signal })
    if (creating && response.status >= 400 && response.status < 500) {
      const rejected = await response.json().catch(() => null) as Body | null
      const detail = String(rejected?.data?.message ?? rejected?.message ?? 'no detail')
      throw new MvsepError('MVSEP_CREATE_REFUSED', `MVSEP refused the create (HTTP ${response.status}): ${secret ? detail.replaceAll(secret, '[redacted]') : detail}`, false,
        'Correct the key, route options or account limit before explicitly starting new work.', 'submitting', response.status)
    }
    if (!creating && !response.ok) {
      const expired = response.status === 404 || response.status === 410
      throw new MvsepError(expired ? 'MVSEP_RESULT_EXPIRED' : 'MVSEP_NETWORK',
        `MVSEP status request failed (HTTP ${response.status}).`, !expired && (response.status >= 500 || response.status === 429),
        expired ? 'Check the existing hash in MVSEP. Replacement work spends credits and needs new authorization.' : 'Retry the status request for the same hash; do not recreate the job.', 'poll', response.status)
    }
    const body = await response.json() as Body
    if (!body || typeof body !== 'object') throw new Error('Invalid MVSEP response')
    return { res: response, body }
  } catch (error) {
    if (error instanceof MvsepError) throw error
    const causeCode = (error as { cause?: { code?: string } })?.cause?.code
    // Only these failures prove the server was never contacted. A reset after upload is uncertain.
    const beforeSend = !response && !controller.signal.aborted &&
      ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(causeCode ?? '')
    if (creating && !beforeSend) {
      throw new MvsepError('MVSEP_UNCERTAIN_SUBMIT',
        'The create request may have been accepted, but no usable hash was received. It was not retried.', false,
        'Check MVSEP job history for the saved upload name, route and submission time; reconcile its hash before any new paid create.', 'submitting', response?.status)
    }
    throw new MvsepError('MVSEP_NETWORK',
      creating ? 'MVSEP could not be reached before the request was sent.' : 'MVSEP status request timed out or returned an unreadable response.', true,
      creating ? 'Retry this planned call after connectivity recovers.' : 'Advance the same hash again; no new paid submission is needed.', creating ? 'submitting' : 'poll')
  } finally { clearTimeout(timer) }
}

/** Never automatically retries a paid POST. The caller durably records the attempt first. */
export async function createSeparationJob(
  audio: Buffer, spec: MvsepJobSpec, uploadName: string = `aurora-${randomUUID()}.wav`
): Promise<{ hash: string }> {
  const form = new FormData()
  const apiToken = requireMvsepKey()
  form.append('api_token', apiToken)
  for (const [key, value] of Object.entries(spec)) if (value != null) form.append(key, value)
  form.append('audiofile', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), uploadName)
  const { res, body } = await request(CREATE_URL, { method: 'POST', body: form }, true, apiToken)
  if (body.success === false) {
    const detail = String(body.data?.message ?? body.message ?? 'no detail').replaceAll(apiToken, '[redacted]')
    throw new MvsepError('MVSEP_CREATE_REFUSED', `MVSEP refused the create: ${detail}`, false,
      'Correct the reported request or account problem before explicitly starting new work.', 'submitting', res.status)
  }
  if (!res.ok || body.success !== true || typeof body.data?.hash !== 'string' || !body.data.hash) {
    throw new MvsepError('MVSEP_UNCERTAIN_SUBMIT', 'MVSEP did not return an accepted hash. The create was not retried.', false,
      `Check MVSEP job history for upload ${uploadName} before authorizing another paid create.`, 'submitting', res.status)
  }
  return { hash: body.data.hash }
}

export interface SeparationStatus extends SeparationResult { status: string; message?: string }

export async function fetchSeparationStatus(hash: string): Promise<SeparationStatus> {
  const { body } = await request(`${GET_URL}?hash=${encodeURIComponent(hash)}`, {}, false)
  if (body.success === false && body.status !== 'failed' && body.status !== 'not_found') {
    throw new MvsepError('MVSEP_NETWORK', 'MVSEP refused the status request.', true,
      'Check account access and retry the same hash; do not submit replacement work.', 'poll')
  }
  return { status: body.status ?? 'unknown', algorithm: body.data?.algorithm ?? null,
    files: body.data?.files?.map((f) => ({ url: f.url, filename: f.download, label: f.type })) ?? [],
    message: body.data?.message ?? body.message }
}

export function resolveSeparationStatus(hash: string, s: SeparationStatus): SeparationResult | null {
  if (s.status === 'done' && s.files.length > 0) return { algorithm: s.algorithm, files: s.files }
  if (s.status === 'not_found' || (s.status === 'done' && s.files.length === 0)) {
    throw new MvsepError('MVSEP_RESULT_EXPIRED', `MVSEP has no downloadable result for hash ${hash}.`, false,
      'Check the existing hash in MVSEP. A replacement spends credits and requires new authorization.', 'poll')
  }
  if (s.status === 'failed') {
    throw new MvsepError('MVSEP_JOB_FAILED', `MVSEP job ${hash} failed: ${s.message ?? 'no detail'}`, false,
      'Inspect the provider failure. Keep landed outputs; do not automatically submit a replacement.', 'poll')
  }
  if (['waiting', 'processing', 'distributing', 'merging'].includes(s.status)) return null
  throw new MvsepError('MVSEP_NETWORK', `MVSEP returned an unrecognized status: ${s.status}.`, true,
    'Poll the same hash again; no paid create is needed.', 'poll')
}

export async function awaitSeparationResult(
  handle: { hash: string }, onPoll?: (status: string) => void
): Promise<SeparationResult> {
  for (let attempt = 0; attempt < 120; attempt++) {
    await sleep(POLL_DELAY_MS)
    try {
      const status = await fetchSeparationStatus(handle.hash)
      onPoll?.(status.status)
      const result = resolveSeparationStatus(handle.hash, status)
      if (result) return result
    } catch (error) { if (!separationError(error).retryable) throw error }
  }
  throw new MvsepError('MVSEP_NETWORK', `MVSEP hash ${handle.hash} is still pending after the polling window.`, true,
    'Resume polling this hash; do not create another paid job.', 'poll')
}

export const mvsepProvider: SeparationProvider = { createJob: createSeparationJob, awaitResult: awaitSeparationResult }

export interface MvsepUserInfo { premiumMinutes: number | null; premiumEnabled: boolean | null }
export async function getMvsepUserInfo(): Promise<MvsepUserInfo> {
  const { body } = await request(`${USER_URL}?api_token=${encodeURIComponent(requireMvsepKey())}`, {}, false)
  if (body.success === false) throw new MvsepError('MVSEP_NETWORK', 'MVSEP refused the user-info request.', false,
    'Check account access.', 'balance')
  const data = body.data as { premium_minutes?: number; premium_enabled?: number } | undefined
  return { premiumMinutes: data?.premium_minutes ?? null,
    premiumEnabled: data?.premium_enabled != null ? data.premium_enabled === 1 : null }
}
