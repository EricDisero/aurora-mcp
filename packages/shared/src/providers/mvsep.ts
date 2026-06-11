// MVSEP client — port of aurora's verified implementation (src/main/providers/
// separation/dev-direct.ts), re-verified against live mvsep.com docs +
// GET /api/app/algorithms on 2026-06-10. Adds a single-shot status fetch for
// the background-job model and the free user-info balance call.
// Contract: aurora/docs/build-specs/mvsep-separation-contract.md.

import { requireMvsepKey } from '../config.js'
import type { MvsepJobSpec, SeparationResultFile } from '../types.js'

export const MVSEP_BASE_URL = 'https://mvsep.com'

const CREATE_URL = `${MVSEP_BASE_URL}/api/separation/create`
const GET_URL = `${MVSEP_BASE_URL}/api/separation/get`
const USER_URL = `${MVSEP_BASE_URL}/api/app/user`

const MAX_RETRIES = 5
const BASE_RETRY_DELAY_MS = 3000 // exp backoff: 3 * 2**(r-1) seconds
const POLL_DELAY_MS = 5000
const MAX_POLL_ATTEMPTS = 120 // ~10 min ceiling

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Submit one separation job (multipart, field MUST be "audiofile"). */
export async function createSeparationJob(
  audio: Buffer,
  spec: MvsepJobSpec
): Promise<{ hash: string }> {
  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const form = new FormData()
      form.append('api_token', requireMvsepKey())
      form.append('sep_type', spec.sep_type)
      form.append('output_format', spec.output_format)
      form.append('is_demo', spec.is_demo)
      if (spec.add_opt1 != null) form.append('add_opt1', spec.add_opt1)
      if (spec.add_opt2 != null) form.append('add_opt2', spec.add_opt2)

      const blob = new Blob([new Uint8Array(audio)], { type: 'audio/wav' })
      form.append('audiofile', blob, 'input.wav')

      const res = await fetch(CREATE_URL, { method: 'POST', body: form })
      const body = (await res.json()) as {
        success: boolean
        data?: { hash?: string; message?: string }
      }

      if (!res.ok || !body.success || !body.data?.hash) {
        throw new Error(
          `MVSEP create failed (HTTP ${res.status}): ${body.data?.message || 'unknown error'}`
        )
      }

      return { hash: body.data.hash }
    } catch (err) {
      lastError = err
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1))
      }
    }
  }

  throw new Error(
    `MVSEP create failed after ${MAX_RETRIES} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  )
}

export interface SeparationStatus {
  /** waiting | processing | distributing | merging | done | failed | not_found */
  status: string
  files?: SeparationResultFile[]
  message?: string
}

/** ONE status fetch (no waiting) — the background-job model's poll unit. */
export async function fetchSeparationStatus(hash: string): Promise<SeparationStatus> {
  const res = await fetch(`${GET_URL}?hash=${encodeURIComponent(hash)}`)
  const body = (await res.json()) as {
    success?: boolean
    status?: string
    data?: { files?: Array<{ url: string; download: string }>; message?: string }
  }
  const status = body.status ?? 'unknown'
  return {
    status,
    files: body.data?.files?.map((f) => ({ url: f.url, filename: f.download })),
    message: body.data?.message
  }
}

/** Interpret a status: returns files when done, null while in flight, throws on
 *  terminal failure. */
export function resolveSeparationStatus(hash: string, s: SeparationStatus): SeparationResultFile[] | null {
  switch (s.status) {
    case 'done':
      if (!s.files || s.files.length === 0) {
        throw new Error(
          `MVSEP job ${hash} is done but returned no result files — results are deleted server-side ` +
            'after a retention window; the job likely expired before download. Re-run the split.'
        )
      }
      return s.files
    case 'failed':
      throw new Error(`MVSEP job failed: ${s.message || 'no detail'}`)
    case 'not_found':
      throw new Error(`MVSEP job not found (hash invalid, expired, or result already deleted): ${hash}`)
    case 'waiting':
    case 'processing':
    case 'distributing':
    case 'merging':
      return null
    default:
      throw new Error(`MVSEP unknown job status: ${s.status}`)
  }
}

/** Blocking poll until the job is done; returns the result files. */
export async function awaitSeparationResult(
  handle: { hash: string },
  onPoll?: (status: string) => void
): Promise<SeparationResultFile[]> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_DELAY_MS)

    let s: SeparationStatus
    try {
      s = await fetchSeparationStatus(handle.hash)
    } catch {
      continue // transient network blip — keep polling
    }

    onPoll?.(s.status)
    const files = resolveSeparationStatus(handle.hash, s)
    if (files) return files
  }

  throw new Error('MVSEP job timed out (exceeded ~10 min poll ceiling)')
}

export interface MvsepUserInfo {
  premiumMinutes: number | null
  premiumEnabled: boolean | null
}

/** Free balance call — premium minutes + premium flag from /api/app/user. */
export async function getMvsepUserInfo(): Promise<MvsepUserInfo> {
  const res = await fetch(`${USER_URL}?api_token=${encodeURIComponent(requireMvsepKey())}`)
  const body = (await res.json()) as {
    success?: boolean
    data?: { premium_minutes?: number; premium_enabled?: number }
  }
  if (!res.ok || body.success === false) {
    throw new Error(`MVSEP user info failed (HTTP ${res.status})`)
  }
  return {
    premiumMinutes: body.data?.premium_minutes ?? null,
    premiumEnabled: body.data?.premium_enabled != null ? body.data.premium_enabled === 1 : null
  }
}
