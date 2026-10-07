// Offline protocol/contract checks: npm run test:surface (after npm run build). Not published (package.json files).
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ProgressNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { ALL_OPERATIONS, SKILLS, loadJob } from '@ericdisero/aurora-shared'
import { createAuroraServer, SERVER_INSTRUCTIONS } from './server.js'

/** A mono 32-bit float WAV, written here so the test needs nothing outside the published packages. */
async function writeSilentWav(path: string, frames: number, sampleRate: number): Promise<void> {
  const data = frames * 4
  const buf = Buffer.alloc(44 + data)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data, 4); buf.write('WAVE', 8); buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(32, 34); buf.write('data', 36); buf.writeUInt32LE(data, 40)
  await writeFile(path, buf)
}

const scratch = await mkdtemp(join(tmpdir(), 'aurora-surface-test-'))
const previousUserData = process.env.AURORA_USER_DATA
process.env.AURORA_USER_DATA = scratch
const originalFetch = globalThis.fetch
let networkAttempts = 0
globalThis.fetch = async () => { networkAttempts++; throw new Error('Offline surface tests forbid all provider/network requests') }
const server = createAuroraServer()
const client = new Client({ name: 'aurora-offline-test', version: '1' })
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
const callTool = async (params: Parameters<Client['callTool']>[0]): Promise<{
  isError?: boolean; structuredContent?: Record<string, unknown>
}> => await client.callTool(params) as { isError?: boolean; structuredContent?: Record<string, unknown> }

try {
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS)
  assert.ok(SERVER_INSTRUCTIONS.length <= 512)
  const { tools } = await client.listTools()
  assert.equal(tools.length, ALL_OPERATIONS.length)
  assert.equal(tools.length, 51)
  for (const name of ['aurora_get_recipe', 'aurora_copy_recipe', 'aurora_reuse_prompt', 'aurora_reuse_reference', 'aurora_make_variations']) {
    assert.ok(tools.some((tool) => tool.name === name), `${name} listed on first request`)
  }
  for (const name of ['aurora_get_stem_peaks', 'aurora_measure_stems', 'aurora_export_stems']) {
    const tool = tools.find((tool) => tool.name === name)!
    assert.ok(tool, `${name} listed on first request`)
    assert.equal(tool.annotations!.readOnlyHint, name !== 'aurora_export_stems')
    assert.equal(tool.annotations!.openWorldHint, false)
    assert.equal(tool.annotations!.destructiveHint, false)
  }
  assert.ok(tools.some((tool) => tool.name === 'aurora_get_view'))
  assert.ok(tools.some((tool) => tool.name === 'aurora_set_view'))
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length <= 2048, tool.name)
    assert.equal(typeof tool.annotations?.title, 'string')
    for (const hint of (['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const)) {
      assert.equal(typeof tool.annotations?.[hint], 'boolean', `${tool.name}: ${hint}`)
    }
    assert.equal(tool.outputSchema?.type, 'object', tool.name)
    assert.ok(!JSON.stringify(tool.inputSchema).includes('"nullable"'), tool.name)
  }
  const move = tools.find((tool) => tool.name === 'aurora_set_asset_track')!
  assert.ok(JSON.stringify(move.inputSchema).includes('"null"'))
  assert.equal(tools.find((tool) => tool.name === 'aurora_get_job_status')!.annotations!.readOnlyHint, false)
  assert.equal(tools.find((tool) => tool.name === 'aurora_list_jobs')!.annotations!.openWorldHint, false)
  for (const op of ALL_OPERATIONS) {
    const controller = new AbortController(); controller.abort()
    const result = await op.run({}, { signal: controller.signal })
    assert.equal(result.isError, true)
    assert.equal((result.structuredContent.error as { code: string }).code, 'REQUEST_CANCELLED')
    assert.ok(op.outputSchema.safeParse(result.structuredContent).success, op.id)
  }
  const routes = await callTool({ name: 'aurora_list_separation_routes', arguments: {} })
  assert.ok(!routes.isError)
  assert.ok(Array.isArray(routes.structuredContent?.routes))
  const filtered = await callTool({ name: 'aurora_list_separation_routes', arguments: { surface: 'split' } })
  assert.equal((filtered.structuredContent?.routes as unknown[]).length, 3)
  const extract = ALL_OPERATIONS.find((op) => op.id === 'aurora_extract')!
  for (const stem of ['drums_full', 'percussion', 'vocals_all', 'choir', 'brass', 'woodwind', 'strings', 'keys', 'guitar']) {
    assert.ok(extract.input.safeParse({ assetId: 'test', stems: [stem] }).success, stem)
  }
  assert.ok(!extract.input.safeParse({ assetId: 'test', stems: ['not_a_stem'] }).success)
  const guides = await callTool({ name: 'aurora_get_prompting_guide', arguments: {} })
  assert.equal((guides.structuredContent?.guides as unknown[]).length, 5)
  for (const topic of Object.keys(SKILLS)) {
    const result = await callTool({ name: 'aurora_get_prompting_guide', arguments: { topic } })
    assert.equal(result.structuredContent?.content, SKILLS[topic])
    assert.ok(!result.isError)
  }
  for (const topic of ['__proto__', 'constructor', 'aurora']) {
    const result = await callTool({ name: 'aurora_get_prompting_guide', arguments: { topic } })
    assert.equal(result.isError, true)
  }
  const invalid = await callTool({ name: 'aurora_extract', arguments: { assetId: 'test', stems: ['bogus'] } })
  assert.equal(invalid.isError, true)
  assert.equal((invalid.structuredContent?.error as { code: string }).code, 'INVALID_ARGUMENT')
  await assert.rejects(callTool({ name: 'unknown', arguments: {} }), /Unknown tool/)
  const created = await callTool({ name: 'aurora_create_project', arguments: { name: 'Offline contract test' } })
  assert.ok(!created.isError)
  const projectId = (created.structuredContent?.project as { id: string }).id
  const audioPath = join(scratch, 'input.wav')
  await writeSilentWav(audioPath, 44100, 44100)
  const imported = await callTool({ name: 'aurora_import_file', arguments: { projectId, filePath: audioPath } })
  assert.ok(!imported.isError)
  const assetId = (imported.structuredContent?.asset as { id: string }).id
  const stemSet = await callTool({ name: 'aurora_create_stem_set', arguments: {
    assetId, name: 'Local stems', lanes: [{ stemKey: 'silent', path: audioPath }]
  } })
  const setKey = `set:${(stemSet.structuredContent?.set as { id: string }).id}`
  const peaks = await callTool({ name: 'aurora_get_stem_peaks', arguments: { assetId, setKey } })
  assert.ok(!peaks.isError)
  assert.equal((peaks.structuredContent?.lanes as Array<{ peaks: unknown[] }>)[0].peaks.length, 400)
  const levels = await callTool({ name: 'aurora_measure_stems', arguments: { assetId, setKey } })
  assert.ok(!levels.isError)
  assert.equal((levels.structuredContent?.lanes as Array<{ integratedLufs: number | null }>)[0].integratedLufs, null)
  const exported = await callTool({ name: 'aurora_export_stems', arguments: {
    assetId, setKey, mode: 'mix', outDir: join(scratch, 'exports')
  } })
  assert.ok(!exported.isError)
  assert.equal((exported.structuredContent?.manifest as { peak: number }).peak, 0)
  const splitPlan = await callTool({ name: 'aurora_split', arguments: { assetId, estimateOnly: true } })
  assert.ok(!splitPlan.isError)
  assert.equal(splitPlan.structuredContent?.totalCalls, 3)
  assert.equal(splitPlan.structuredContent?.price, null)
  const extractPlan = await callTool({ name: 'aurora_extract', arguments: { assetId, stems: ['strings'], estimateOnly: true } })
  assert.ok(!extractPlan.isError)
  assert.equal(extractPlan.structuredContent?.totalCalls, 1)
  assert.ok((extractPlan.structuredContent?.calls as Array<{ quality: string }>)[0].quality)
  const unconfirmed = await callTool({ name: 'aurora_delete_asset', arguments: { assetId } })
  assert.equal(unconfirmed.isError, true)
  assert.equal((unconfirmed.structuredContent?.error as { code: string }).code, 'CONFIRMATION_REQUIRED')
  const check = await callTool({ name: 'aurora_check_separation_result', arguments: {
    routeId: 'split-vocals', inputPath: join(scratch, 'missing.wav'), outputs: {}
  } })
  assert.equal(check.structuredContent?.ok, false)
  assert.ok(!check.isError, 'A completed local check returns its verdict, including ok:false')
  assert.ok(Array.isArray(check.structuredContent?.problems))

  const job = { version: 1, jobId: 'gen-offline', kind: 'generate', status: 'queued',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), projectId: 'offline',
    baseName: 'offline', params: {}, provider: {}, landed: {}, assetIds: [], stems: [], stage: 'queued' }
  await mkdir(join(scratch, 'agent-jobs'))
  await writeFile(join(scratch, 'agent-jobs', job.jobId + '.json'), JSON.stringify(job))
  const snapshot = await callTool({ name: 'aurora_get_job_status', arguments: { jobId: job.jobId, advance: false } })
  assert.equal(snapshot.structuredContent?.status, 'queued')
  const progress: Array<{ progressToken: string | number; progress: number }> = []
  client.setNotificationHandler(ProgressNotificationSchema, (notification) => { progress.push(notification.params) })
  const failed = await callTool({ name: 'aurora_get_job_status', arguments: { jobId: job.jobId }, _meta: { progressToken: 0 } })
  assert.equal(failed.isError, true)
  assert.equal(failed.structuredContent?.status, 'failed')
  assert.equal((failed.structuredContent?.error as { jobId: string }).jobId, job.jobId)
  assert.ok(progress.some((notification) => notification.progressToken === 0))
  assert.ok(progress.every((notification, index) => index === 0 || notification.progress >= progress[index - 1].progress))
  const jobList = await callTool({ name: 'aurora_list_jobs', arguments: {} })
  assert.ok(!jobList.isError)
  assert.equal((jobList.structuredContent?.jobs as unknown[]).length, 1)
  const cancelled = await callTool({ name: 'aurora_cancel_job', arguments: { jobId: job.jobId } })
  assert.equal(cancelled.structuredContent?.status, 'failed')
  const queued = { ...job, jobId: 'gen-cancel-offline' }
  await writeFile(join(scratch, 'agent-jobs', queued.jobId + '.json'), JSON.stringify(queued))
  const stopped = await callTool({ name: 'aurora_cancel_job', arguments: { jobId: queued.jobId } })
  assert.equal(stopped.structuredContent?.status, 'cancelled')
  assert.ok(!stopped.isError)
  const partial = { ...job, jobId: 'ext-partial-offline', kind: 'extract', status: 'partial',
    stems: [{ stemType: 'piano', path: join(scratch, 'piano.wav') }],
    lastError: { code: 'OUTPUT_IDENTITY', message: 'Incorrect output keys', retryable: false, nextAction: 'Inspect saved outputs.' },
    provider: { extract: { assetId: 'offline', extractDir: scratch, originalPath: join(scratch, 'input.wav'),
      calls: [], callIndex: 0, currentHash: null, vocalDryPath: null, extractedFiles: { piano: join(scratch, 'piano.wav') },
      detectedKey: 'C major', requestedStemIds: ['piano', 'strings'], failures: ['strings: incorrect outputs'],
      callResults: [{ routeId: 'strings', status: 'failed', deliveredStemIds: [],
        error: { code: 'OUTPUT_IDENTITY', message: 'Incorrect output keys', retryable: false, nextAction: 'Inspect saved outputs.' } }] } } }
  await writeFile(join(scratch, 'agent-jobs', partial.jobId + '.json'), JSON.stringify(partial))
  const partialResult = await callTool({ name: 'aurora_get_job_status', arguments: { jobId: partial.jobId, advance: false } })
  assert.equal(partialResult.isError, true)
  assert.equal(partialResult.structuredContent?.status, 'partial')
  assert.deepEqual(partialResult.structuredContent?.requestedStemIds, ['piano', 'strings'])
  assert.equal(partialResult.structuredContent?.detectedKey, 'C major')
  assert.equal((partialResult.structuredContent?.callResults as unknown[]).length, 1)
  // Confirmed variation jobs join the connection worker. No provider handles: they fail locally.
  const variation = ALL_OPERATIONS.find((op) => op.id === 'aurora_make_variations')!
  const realVariationRun = variation.run
  const variationIds = ['gen-variation-one', 'gen-variation-two']
  for (const jobId of variationIds) {
    await writeFile(join(scratch, 'agent-jobs', `${jobId}.json`), JSON.stringify({ ...job, jobId }))
  }
  try {
    variation.run = async () => {
      const data = { planned: 2, call: { op: 'aurora_generate', args: {} }, estimatedCredits: [],
        results: variationIds.map((jobId) => ({ structuredContent: { jobId, status: 'queued' } })) }
      return { text: 'Stubbed variation jobs', data, structuredContent: data }
    }
    await callTool({ name: 'aurora_make_variations', arguments: { assetId: 'stub', count: 2, confirm: true } })
    await new Promise((resolve) => setTimeout(resolve, 6000))
    for (const jobId of variationIds) assert.equal((await loadJob(jobId))?.status, 'failed', 'Variation job advanced by connection worker')
  } finally { variation.run = realVariationRun }
  const prompts = await client.listPrompts()
  assert.equal(prompts.prompts.length, 6)
  assert.ok((await client.getPrompt({ name: 'aurora-separation' })).messages.length)
  const resources = await client.listResources()
  assert.equal(resources.resources.length, 9)
  for (const uri of ['aurora://capabilities', 'aurora://routes', 'aurora://guides', 'aurora://jobs', `aurora://job/${job.jobId}`]) {
    assert.ok((await client.readResource({ uri })).contents.length)
  }
  assert.equal(networkAttempts, 0, 'No provider or network requests may be attempted')
  assert.deepEqual((await client.listTools()).tools, tools, 'Tool list stays fixed for the connection')
  console.log(`Offline surface checks passed: ${tools.length} tools, ${(routes.structuredContent?.routes as unknown[]).length} routes, 5 guides; no provider calls.`)
} finally {
  await client.close()
  await server.close()
  globalThis.fetch = originalFetch
  if (previousUserData === undefined) delete process.env.AURORA_USER_DATA
  else process.env.AURORA_USER_DATA = previousUserData
  console.log(`Isolated test fixture: ${scratch}`)
}
