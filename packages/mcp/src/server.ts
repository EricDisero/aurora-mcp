#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError,
  ListPromptsRequestSchema, GetPromptRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_OPERATIONS, SKILLS, advanceJob, isJobActive, loadJob,
  type Operation, type OperationProgress } from '@ericdisero/aurora-shared'
import { operationTool, toolResult } from './surface.js'

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version: string }

export const SERVER_INSTRUCTIONS = 'Aurora workflow v1: list separation routes -> plan with split/extract estimateOnly:true -> explicitly run split/extract -> status -> check. Paid tools upload audio and spend Suno/MVSEP credits. Queued background jobs progress while connected; resume via status after reconnecting. Status mutates by default; advance:false and list_jobs are local snapshots. Cancellation stops future units; accepted provider work may still run and is not refunded.'

/** Pump only jobs explicitly started/resumed here; engine leases serialize with other processes.
 * Closing the connection stops future units, leaving durable manifests available for resumption. */
function jobWorker() {
  const ids = new Set<string>()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let pumping = false
  function schedule(): void {
    if (timer || pumping || controller.signal.aborted || !ids.size) return
    timer = setTimeout(() => { timer = undefined; void pump() }, 5000)
    timer.unref()
  }
  async function pump(): Promise<void> {
    pumping = true
    try {
      for (const id of ids) {
        if (controller.signal.aborted) break
        try {
          const job = await loadJob(id)
          if (!job || !isJobActive(job)) { ids.delete(id); continue }
          const advanced = await advanceJob(job, controller.signal)
          if (!isJobActive(advanced)) ids.delete(id)
        } catch (error) {
          ids.delete(id)
          console.error(`[aurora-mcp] job ${id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally { pumping = false; schedule() }
  }
  return {
    watch(id: string): void { if (!controller.signal.aborted) { ids.add(id); schedule() } },
    stop(): void { controller.abort(); if (timer) clearTimeout(timer); timer = undefined; ids.clear() }
  }
}

export function createAuroraServer(): Server {
  const ops = ALL_OPERATIONS as readonly Operation<unknown>[]
  const byId = new Map(ops.map((op) => [op.id, op]))
  const worker = jobWorker()
  const server = new Server({ name: 'aurora-audio', version: pkg.version }, {
    instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {}, prompts: {}, resources: {} }
  })
  server.onclose = () => worker.stop()
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ops.map(operationTool) }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const op = byId.get(request.params.name)
    if (!op) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`)
    const token = request.params._meta?.progressToken
    let lastSent = 0
    let lastMessage = ''
    let completed = 0
    const progress = async (update: OperationProgress): Promise<void> => {
      if (token === undefined || extra.signal.aborted) return
      completed = Math.max(completed, update.progress)
      const now = Date.now()
      if (now - lastSent < 1000 || (lastMessage === update.message && now - lastSent < 5000)) return
      lastSent = now; lastMessage = update.message
      try {
        await extra.sendNotification({ method: 'notifications/progress', params: {
          progressToken: token, progress: completed, ...(update.total === undefined ? {} : { total: update.total }),
          message: update.message
        } })
      } catch { /* Transport closure must not discard an accepted paid job's durable handle. */ }
    }
    const result = await op.run(request.params.arguments ?? {}, { signal: extra.signal, onProgress: progress })
    const data = result.structuredContent
    // Pure snapshots and cancellation do not start/resume paid work.
    if (!extra.signal.aborted && !op.annotations.readOnlyHint && op.id !== 'aurora_cancel_job' &&
      !(op.id === 'aurora_get_job_status' && request.params.arguments?.advance === false)) {
      const jobs = op.id === 'aurora_make_variations' && request.params.arguments?.confirm === true && Array.isArray(data.results)
        ? data.results.map((result: { structuredContent: Record<string, unknown> }) => result.structuredContent)
        : [data]
      for (const job of jobs) {
        if (typeof job?.jobId === 'string' && ['queued', 'submitting', 'waiting', 'landing', 'running'].includes(String(job.status))) {
          worker.watch(job.jobId)
        }
      }
    }
    return toolResult(result)
  })

  const guides = Object.keys(SKILLS).map((name) => ({ name,
    description: /^description:\s*(.+)$/m.exec(SKILLS[name])?.[1]?.trim() ?? name }))
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [
    { name: 'aurora-separation', description: 'Plan measured separation before spending and check outputs.',
      arguments: [{ name: 'assetId', description: 'Existing Aurora asset id', required: false }] },
    ...guides
  ] }))
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params.name
    if (name === 'aurora-separation') return { description: 'Aurora separation workflow', messages: [
      { role: 'user' as const, content: { type: 'text' as const,
        text: `Inspect workspace/assets${request.params.arguments?.assetId ? ` for asset ${request.params.arguments.assetId}` : ''}. List measured routes and compare quality/evidence. Plan with split/extract estimateOnly:true. Obtain spend authorization before paid tools. Background work queues and progresses while connected; status may submit paid calls. Inspect partial failures and local checks. Cancellation does not refund accepted work.` } }
    ] }
    if (!Object.hasOwn(SKILLS, name)) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`)
    return { description: guides.find((guide) => guide.name === name)?.description, messages: [
      { role: 'user' as const, content: { type: 'text' as const, text: SKILLS[name] } }
    ] }
  })
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [
    { uri: 'aurora://capabilities', name: 'Tools and effects', mimeType: 'application/json' },
    { uri: 'aurora://routes', name: 'Measured separation routes', mimeType: 'application/json' },
    { uri: 'aurora://guides', name: 'Offline guide index', mimeType: 'application/json' },
    { uri: 'aurora://jobs', name: 'Local job snapshots (no advancement)', mimeType: 'application/json' },
    ...guides.map((guide) => ({ uri: `aurora://guide/${encodeURIComponent(guide.name)}`, ...guide, mimeType: 'text/markdown' }))
  ] }))
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [
    { uriTemplate: 'aurora://job/{jobId}', name: 'Local job snapshot', mimeType: 'application/json' }
  ] }))
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri
    let data: unknown
    let mimeType = 'application/json'
    if (uri === 'aurora://capabilities') data = { instructions: SERVER_INSTRUCTIONS, tools: ops.map(operationTool) }
    else if (uri === 'aurora://guides') data = guides
    else if (uri === 'aurora://routes') data = (await byId.get('aurora_list_separation_routes')!.run({})).structuredContent
    else if (uri === 'aurora://jobs') data = (await byId.get('aurora_list_jobs')!.run({})).structuredContent
    else if (uri.startsWith('aurora://job/')) {
      const jobId = uri.slice('aurora://job/'.length)
      data = (await byId.get('aurora_get_job_status')!.run({ jobId, advance: false })).structuredContent
    } else if (uri.startsWith('aurora://guide/')) {
      let name: string
      try { name = decodeURIComponent(uri.slice('aurora://guide/'.length)) }
      catch { throw new McpError(ErrorCode.InvalidParams, 'Malformed guide URI') }
      if (!Object.hasOwn(SKILLS, name)) throw new McpError(ErrorCode.InvalidParams, `Unknown guide: ${name}`)
      data = SKILLS[name]; mimeType = 'text/markdown'
    } else throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`)
    return { contents: [{ uri, mimeType, text: typeof data === 'string' ? data : JSON.stringify(data) }] }
  })
  return server
}

async function main(): Promise<void> {
  const server = createAuroraServer()
  await server.connect(new StdioServerTransport())
  console.error(`[aurora-mcp] server started, ${ALL_OPERATIONS.length} tools registered`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error('[aurora-mcp] fatal:', error); process.exitCode = 1 })
}
