import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

// Wire contract mirrored from aurora/src/main/agent/protocol.ts; the free bridge test checks it.
export const DESKTOP_PROTOCOL_VERSION = 1
export const DESKTOP_CAPABILITIES = ['view', 'view-set', 'request-ack'] as const
export const DESKTOP_PAGES = ['create', 'library', 'extract', 'finish', 'split', 'settings'] as const
const id = z.string().trim().min(1).max(256)
export const viewPatchSchema = z.object({
  page: z.enum(DESKTOP_PAGES).optional(),
  openAssetId: id.nullable().optional(),
  selectedAssetIds: z.array(id).max(500).optional(),
  libraryTrackId: id.nullable().optional()
}).strict().refine((patch) => Object.keys(patch).length > 0, 'Name at least one view field')
export const viewCommandSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  expectedRevision: z.number().int().nonnegative().optional(),
  patch: viewPatchSchema
}).strict()
export const viewStateSchema = z.object({
  route: z.string().startsWith('/'), projectId: id.nullable(), openAssetId: id.nullable(),
  selectedAssetIds: z.array(id).max(500), activePanel: z.string(), libraryTrackId: id.nullable(),
  revision: z.number().int().nonnegative(), observedAt: z.string().datetime()
})
export const viewReadSchema = z.object({ connected: z.boolean(), state: viewStateSchema.nullable(), reason: z.string().optional() })
export const viewAckSchema = z.object({
  connected: z.boolean(), requestId: z.string(), status: z.enum(['applied', 'partial', 'rejected', 'uncertain']),
  state: viewStateSchema.nullable(), revision: z.number().int().nonnegative().nullable(), reasons: z.array(z.string())
})
type ViewCommand = z.infer<typeof viewCommandSchema>
type ViewAck = z.infer<typeof viewAckSchema>
const connectionSchema = z.object({
  port: z.number().int().min(1).max(65535), token: z.string().min(32), pid: z.number().int().positive(),
  appVersion: z.string().min(1), protocolVersion: z.number().int(), capabilities: z.array(z.string())
})
const healthSchema = connectionSchema.omit({ port: true, token: true }).extend({ service: z.literal('aurora-agent') })

export function desktopConnectionPath(): string { return join(homedir(), '.aurora', 'agent-connection.json') }

export class DesktopError extends Error {
  retryable = false
  nextAction = 'Open Aurora, or update the desktop app and MCP package together, then retry.'
  constructor(public code: string, message: string) { super(message) }
}

function compatible(connection: z.infer<typeof healthSchema> | z.infer<typeof connectionSchema>, capability: string): void {
  if (connection.protocolVersion !== DESKTOP_PROTOCOL_VERSION) throw new DesktopError('DESKTOP_PROTOCOL_MISMATCH', `Desktop protocol ${connection.protocolVersion} is unsupported; expected ${DESKTOP_PROTOCOL_VERSION}`)
  if (!connection.capabilities.includes(capability)) throw new DesktopError('DESKTOP_CAPABILITY_MISSING', `Desktop does not support ${capability}; update Aurora`)
}

export class AuroraDesktopClient {
  constructor(private options: { connectionFile?: string; timeoutMs?: number } = {}) {}

  private discover(): z.infer<typeof connectionSchema> {
    let raw: string
    try { raw = readFileSync(this.options.connectionFile ?? desktopConnectionPath(), 'utf8') }
    catch { throw new DesktopError('DESKTOP_NOT_CONNECTED', 'desktop app not connected: open Aurora and retry') }
    try { return connectionSchema.parse(JSON.parse(raw)) }
    catch { throw new DesktopError('DESKTOP_CONNECTION_INVALID', 'Desktop connection file is invalid; restart Aurora') }
  }

  private async request(connection: z.infer<typeof connectionSchema>, path: string, command?: ViewCommand): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 6000)
    try {
      const res = await fetch(`http://127.0.0.1:${connection.port}${path}`, {
        method: command ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${connection.token}`, ...(command ? { 'Content-Type': 'application/json' } : {}) },
        ...(command ? { body: JSON.stringify(command) } : {})
      })
      if (res.status === 401 || res.status === 403) throw new DesktopError('DESKTOP_AUTH_FAILED', `Desktop authentication refused (${res.status}); restart Aurora and rediscover its connection file`)
      if (!res.ok) throw new DesktopError('DESKTOP_REQUEST_FAILED', `Desktop ${path} failed (${res.status}): ${await res.text()}`)
      return await res.json()
    } catch (error) {
      if (error instanceof DesktopError) throw error
      if (controller.signal.aborted) throw new DesktopError('DESKTOP_TIMEOUT', 'Desktop response timed out; the action may still be running')
      throw new DesktopError(command ? 'DESKTOP_OUTCOME_UNKNOWN' : 'DESKTOP_NOT_CONNECTED', command ?
        'Desktop command connection was lost; the action may have been applied' : 'desktop app not connected: open Aurora and retry')
    } finally { clearTimeout(timer) }
  }

  private async connect(capability: string): Promise<z.infer<typeof connectionSchema>> {
    const connection = this.discover()
    compatible(connection, capability)
    const health = healthSchema.parse(await this.request(connection, '/agent/healthz'))
    compatible(health, capability)
    compatible(health, 'request-ack')
    if (health.pid !== connection.pid || health.appVersion !== connection.appVersion) throw new DesktopError('DESKTOP_CONNECTION_STALE', 'Desktop identity differs from the connection file; rediscover after restarting Aurora')
    return connection
  }

  async getView(): Promise<z.infer<typeof viewReadSchema>> {
    try {
      const connection = await this.connect('view')
      return viewReadSchema.parse(await this.request(connection, '/agent/view'))
    } catch (error) {
      if (error instanceof DesktopError && error.code === 'DESKTOP_NOT_CONNECTED') return { connected: false, state: null, reason: error.message }
      throw error
    }
  }

  async setView(input: ViewCommand): Promise<ViewAck> {
    const command = viewCommandSchema.parse(input)
    let connection: z.infer<typeof connectionSchema>
    try { connection = await this.connect('view-set') }
    catch (error) {
      if (error instanceof DesktopError && error.code === 'DESKTOP_NOT_CONNECTED') return {
        connected: false, requestId: command.requestId, status: 'rejected', state: null, revision: null, reasons: [error.message]
      }
      throw error
    }
    try {
      const ack = viewAckSchema.parse(await this.request(connection, '/agent/view', command))
      if (ack.requestId !== command.requestId || ack.revision !== (ack.state?.revision ?? null) ||
        (['applied', 'partial'].includes(ack.status) && !ack.state)) throw new Error('Invalid desktop acknowledgement')
      return ack
    } catch (error) {
      if (error instanceof DesktopError && ['DESKTOP_AUTH_FAILED', 'DESKTOP_REQUEST_FAILED'].includes(error.code)) throw error
      // A missing or malformed ack after POST can never prove success or refusal.
      return { connected: true, requestId: command.requestId, status: 'uncertain', state: null, revision: null,
        reasons: [error instanceof Error ? error.message : String(error), 'Read aurora_get_view. Reuse this requestId to retrieve the first result; do not blindly repeat with a new id.'] }
    }
  }
}
