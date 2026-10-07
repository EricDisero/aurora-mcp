// Free MCP contract smoke. The SDK handles framing, initialization and RPC errors.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpError } from '@modelcontextprotocol/sdk/types.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requestOptions = { timeout: 10_000 }

/** Run a connected SDK client against a disposable library and key-config home. */
export async function withIsolatedServer(run, { clientName = 'aurora-contract-test' } = {}) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'aurora-mcp-contract-'))
  const home = join(tempRoot, 'home')
  const userData = join(tempRoot, 'user-data')
  let transport
  let client
  let stderr = ''
  try {
    await Promise.all([mkdir(home), mkdir(userData)])
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(SUNO_|MVSEP_|KIE_|AURORA_|NODE_OPTIONS$|NODE_PATH$|HOME$|USERPROFILE$|HOMEDRIVE$|HOMEPATH$|APPDATA$|LOCALAPPDATA$|XDG_CONFIG_HOME$|XDG_DATA_HOME$)/i.test(key)))
    Object.assign(env, {
      AURORA_USER_DATA: userData,
      HOME: home,
      USERPROFILE: home,
      HOMEDRIVE: process.platform === 'win32' ? home.slice(0, 2) : '',
      HOMEPATH: process.platform === 'win32' ? home.slice(2) : home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share')
    })
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(repoRoot, 'packages/mcp/dist/server.js')],
      cwd: repoRoot,
      env,
      stderr: 'pipe'
    })
    transport.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000) })
    client = new Client({ name: clientName, version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport, requestOptions)
    return await run(client, tempRoot)
  } catch (error) {
    if (stderr.trim()) console.error(`[server stderr]\n${stderr.trim()}`)
    throw error
  } finally {
    // SDK close ends stdin, then sends SIGTERM/SIGKILL with bounded waits.
    try {
      if (client) await client.close()
    } finally {
      try {
        if (transport) await transport.close()
      } finally {
        const withinTemp = relative(resolve(tmpdir()), resolve(tempRoot))
        assert(withinTemp && withinTemp !== '..' && !withinTemp.startsWith(`..${sep}`), 'cleanup must stay in the temp directory')
        await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  }
}

async function smoke() {
  await withIsolatedServer(async (client, tempRoot) => {
    const failures = []
    const check = async (name, run) => {
      try {
        await run()
        console.log(`PASS ${name}`)
      } catch (error) {
        failures.push(`${name}: ${error.message}`)
        console.error(`FAIL ${failures.at(-1)}`)
      }
    }
    await check('initialize instructions', () => {
      assert.equal(typeof client.getInstructions(), 'string')
      assert(client.getInstructions().trim().length > 0, 'initialize.instructions must be non-empty')
    })
    const tools = []
    await check('README tool count matches registry', async () => {
      const { ALL_OPERATIONS } = await import('../packages/shared/dist/operations/index.js')
      const readme = await readFile(join(repoRoot, 'README.md'), 'utf8')
      const count = /\*\*(\d+) tools\*\*/.exec(readme)
      assert.ok(count, 'README must state its tool count')
      assert.equal(Number(count[1]), ALL_OPERATIONS.length)
    })
    await check('tools/list', async () => {
      let cursor
      const seenCursors = new Set()
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, requestOptions)
        tools.push(...page.tools)
        cursor = page.nextCursor
        if (cursor) {
          assert(!seenCursors.has(cursor), 'tools/list cursor must advance')
          seenCursors.add(cursor)
          assert(seenCursors.size < 100, 'tools/list exceeded 100 pages')
        }
      } while (cursor)
      assert(tools.length > 0, 'the tool registry must not be empty')
      assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length, 'tool names must be unique')
    })
    for (const [name, predicate] of [
      ['descriptions (at least 80 characters)', (tool) => typeof tool.description === 'string' && tool.description.trim().length >= 80],
      ['inputSchema', (tool) => tool.inputSchema?.type === 'object'],
      ['outputSchema', (tool) => tool.outputSchema?.type === 'object'],
      ['annotation titles', (tool) => typeof tool.annotations?.title === 'string' && tool.annotations.title.trim().length > 0],
      ...['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].map((hint) =>
        [`annotations.${hint}`, (tool) => typeof tool.annotations?.[hint] === 'boolean'])
    ]) {
      await check(`every tool declares ${name}`, () => {
        assert(tools.length > 0, 'no tools discovered')
        const missing = tools.filter((tool) => !predicate(tool)).map((tool) => tool.name)
        assert.equal(missing.length, 0, `missing/invalid on: ${missing.join(', ')}`)
      })
    }
    await check('new tool discovery', () => {
      const missing = ['aurora_list_separation_routes', 'aurora_check_separation_result', 'aurora_cancel_job',
        'aurora_get_recipe', 'aurora_copy_recipe', 'aurora_reuse_prompt', 'aurora_reuse_reference', 'aurora_make_variations']
        .filter((name) => !tools.some((tool) => tool.name === name))
      assert.equal(missing.length, 0, `missing ${missing.join(', ')}`)
    })
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, undefined, requestOptions)
      assert.notEqual(result.isError, true, JSON.stringify(result))
      assert(result.structuredContent && typeof result.structuredContent === 'object', 'successful calls need structuredContent')
      assert(result.content.some((item) => item.type === 'text' && item.text.trim()), 'successful calls need a text summary')
      return result.structuredContent
    }
    await check('separation routes and measured drums quality', async () => {
      const data = await call('aurora_list_separation_routes')
      assert(Array.isArray(data.routes), 'structuredContent.routes must be an array')
      assert(data.routes.length >= 50, `expected at least 50 routes, got ${data.routes.length}`)
      assert.equal(data.routes.find((route) => route.id === 'drums_full')?.quality, 'good')
    })
    await check('empty isolated library', async () => {
      const data = await call('aurora_list_projects')
      assert.deepEqual(data.projects, [], 'a fresh library must contain no projects')
    })
    await check('legacy job snapshots relabel ids and retain files', async () => {
      const jobsDir = join(tempRoot, 'user-data', 'agent-jobs')
      await mkdir(jobsDir)
      const legacyPath = join(tempRoot, 'ee.wav')
      await writeFile(legacyPath, 'existing audio stays in place')
      for (const kind of ['split', 'extract']) {
        const attempt = { routeId: 'piano', status: 'landed', deliveredStemIds: ['ee'] }
        const manifest = {
          version: 1, jobId: `legacy-${kind}`, kind, status: 'completed',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          projectId: 'fixture', baseName: 'legacy', params: { stems: ['ee'] },
          provider: kind === 'split' ? { splitAttempts: { bass: attempt } } : { extract: {
            calls: [{ id: 'piano', routeId: 'piano' }], callIndex: 1, currentHash: null,
            extractedFiles: { ee: legacyPath }, requestedStemIds: ['ee'],
            failures: [], callResults: [attempt]
          } },
          landed: { ee: true }, assetIds: [], stems: [{ stemType: 'ee', path: legacyPath }], stage: 'building everything-else'
        }
        const manifestPath = join(jobsDir, `${manifest.jobId}.json`)
        const original = JSON.stringify(manifest)
        await writeFile(manifestPath, original)
        const data = await call('aurora_get_job_status', { jobId: manifest.jobId, advance: false })
        assert.deepEqual(data.stems, [{ stemType: 'other', path: legacyPath }])
        if (kind === 'extract') {
          assert.deepEqual(data.extractedFiles, { other: legacyPath })
          assert.deepEqual(data.requestedStemIds, ['other'])
          assert.deepEqual(data.callResults[0].deliveredStemIds, ['other'])
        } else assert.deepEqual(data.splitAttempts.bass.deliveredStemIds, ['other'])
        assert.equal(await readFile(manifestPath, 'utf8'), original, 'snapshots must not rewrite manifests')
      }
      assert.equal(await readFile(legacyPath, 'utf8'), 'existing audio stays in place')
    })
    await check('paid tool refuses missing key with actionable error', async () => {
      const result = await client.callTool({ name: 'aurora_generate', arguments: {
        prompt: 'Missing-key contract test', customMode: false, background: true
      } }, undefined, requestOptions)
      assert.equal(result.isError, true, 'missing-key failures must be tool errors')
      const error = result.structuredContent?.error
      assert.equal(error?.code, 'MISSING_KEY')
      assert.equal(typeof error.message, 'string')
      assert(error.message.trim(), 'error.message must be non-empty')
      assert.equal(typeof error.retryable, 'boolean')
      assert.equal(typeof error.nextAction, 'string')
      assert(error.nextAction.trim(), 'error.nextAction must be non-empty')
    })
    await check('unknown tool returns JSON-RPC error', async () => {
      await assert.rejects(
        client.callTool({ name: 'aurora_unknown_contract_test', arguments: {} }, undefined, requestOptions),
        (error) => error instanceof McpError && Number.isInteger(error.code),
        'unknown tool names must reject with an MCP protocol error'
      )
    })
    if (failures.length) throw new AggregateError(failures.map((failure) => new Error(failure)), `${failures.length} MCP smoke assertions failed`)
    console.log(`MCP smoke passed (${tools.length} tools; no provider keys).`)
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smoke().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
