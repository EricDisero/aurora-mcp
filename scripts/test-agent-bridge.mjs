// Free loopback test: fake HTTP desktop, real client and Electron-free app command session.
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { AuroraDesktopClient, desktopConnectionPath, DESKTOP_PROTOCOL_VERSION,
  DESKTOP_CAPABILITIES, DESKTOP_PAGES } from '../packages/shared/dist/clients/desktop.js'
import { ALL_OPERATIONS } from '../packages/shared/dist/operations/index.js'

const moduleUrl = (source) => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
}).outputText).toString('base64')
const protocolUrl = moduleUrl(await readFile(new URL('../../aurora/src/main/agent/protocol.ts', import.meta.url), 'utf8'))
const protocol = await import(protocolUrl)
const viewSource = await readFile(new URL('../../aurora/src/main/agent/view.ts', import.meta.url), 'utf8')
const { ViewSession } = await import(moduleUrl(viewSource.replace("from './protocol'", `from '${protocolUrl}'`)))
assert.equal(protocol.AGENT_PROTOCOL_VERSION, DESKTOP_PROTOCOL_VERSION)
assert.deepEqual(protocol.AGENT_CAPABILITIES, DESKTOP_CAPABILITIES)
assert.deepEqual(protocol.AGENT_PAGES, DESKTOP_PAGES)
assert.equal(desktopConnectionPath(), join(homedir(), '.aurora', 'agent-connection.json'))

const scratch = await mkdtemp(join(tmpdir(), 'aurora-agent-test-'))
const connectionFile = join(scratch, 'agent-connection.json')
const token = 'test-token-'.repeat(8)
let mode = 'apply'
let sends = 0
let inFlight = 0
let maxInFlight = 0
let healthVersion = DESKTOP_PROTOCOL_VERSION
let capabilities = [...DESKTOP_CAPABILITIES]
let state = { route: '/', projectId: 'project', openAssetId: null, selectedAssetIds: [],
  activePanel: 'library', libraryTrackId: null, revision: 1, observedAt: new Date().toISOString() }
const session = new ViewSession((command) => {
  sends++
  if (mode === 'no-ack') return
  inFlight++
  maxInFlight = Math.max(maxInFlight, inFlight)
  setTimeout(() => {
    state = { ...state, route: command.patch.page === 'extract' ? '/extract' : '/',
      activePanel: command.patch.page === 'extract' ? 'extract' : 'library',
      revision: session.getRevision() + 1, observedAt: new Date().toISOString() }
    session.report(state)
    session.acknowledge({ requestId: command.requestId, status: mode === 'partial' ? 'partial' : 'applied',
      state, revision: state.revision, reasons: mode === 'partial' ? ['Fixture selection unavailable'] : [] })
    inFlight--
  }, 10)
}, 80)
session.rendererReady()
session.report(state)
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'Authentication refused' })
  if (req.url === '/agent/healthz') return json(res, 200, { service: 'aurora-agent', pid: process.pid,
    appVersion: 'test', protocolVersion: healthVersion, capabilities })
  if (req.method === 'GET' && req.url === '/agent/view') return json(res, 200, { connected: true, state: session.getState() })
  if (req.method === 'POST' && req.url === '/agent/view') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const command = protocol.parseViewCommand(JSON.parse(Buffer.concat(chunks).toString()))
    if (mode === 'http-timeout') return
    const ack = await session.command(command)
    return json(res, 200, { connected: true, ...ack, ...(mode === 'wrong-id' ? { requestId: 'wrong' } : {}) })
  }
  json(res, 404, {})
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const connection = { port: server.address().port, token, pid: process.pid, appVersion: 'test',
  protocolVersion: DESKTOP_PROTOCOL_VERSION, capabilities: [...DESKTOP_CAPABILITIES] }
const save = async (changes = {}) => writeFile(connectionFile, JSON.stringify({ ...connection, ...changes }))
const client = new AuroraDesktopClient({ connectionFile, timeoutMs: 1000 })
const command = (requestId, expectedRevision) => ({ requestId, ...(expectedRevision === undefined ? {} : { expectedRevision }), patch: { page: 'extract' } })
const getOp = ALL_OPERATIONS.find((op) => op.id === 'aurora_get_view')
const setOp = ALL_OPERATIONS.find((op) => op.id === 'aurora_set_view')

try {
  const missing = await client.getView()
  assert.equal(missing.connected, false)
  assert.equal(missing.state, null)
  assert.match(missing.reason, /desktop app not connected/)
  const absent = await client.setView(command('absent'))
  assert.equal(absent.connected, false)
  assert.equal(absent.status, 'rejected')
  const disconnected = await getOp.run({}, { desktop: () => client })
  assert.equal(disconnected.isError, true)
  assert.ok(getOp.outputSchema.safeParse(disconnected.structuredContent).success)

  await save({ token: 'wrong-token-'.repeat(8) })
  await assert.rejects(client.getView(), (error) => error.code === 'DESKTOP_AUTH_FAILED')
  await save({ protocolVersion: 99 })
  await assert.rejects(client.getView(), (error) => error.code === 'DESKTOP_PROTOCOL_MISMATCH')
  await save()
  healthVersion = 99
  await assert.rejects(client.getView(), (error) => error.code === 'DESKTOP_PROTOCOL_MISMATCH')
  healthVersion = DESKTOP_PROTOCOL_VERSION
  capabilities = ['view']
  await assert.rejects(client.setView(command('unsupported')), (error) => error.code === 'DESKTOP_CAPABILITY_MISSING')
  capabilities = [...DESKTOP_CAPABILITIES]
  assert.equal((await client.getView()).state.route, '/')

  const first = command('first', 1)
  const [applied, duplicate] = await Promise.all([client.setView(first), client.setView(first)])
  assert.equal(applied.status, 'applied')
  assert.equal(applied.state.route, '/extract')
  assert.equal(applied.revision, 2)
  assert.deepEqual(duplicate, applied)
  assert.equal(sends, 1)
  const stale = await client.setView(command('stale', 1))
  assert.equal(stale.status, 'rejected')
  assert.equal(stale.state.revision, 2)
  assert.equal(sends, 1)
  const serial = await Promise.all([client.setView(command('serial-a')), client.setView(command('serial-b'))])
  assert.deepEqual(serial.map((ack) => ack.revision).sort(), [3, 4])
  assert.equal(maxInFlight, 1)
  assert.deepEqual(await client.setView({ ...first, patch: { page: 'library' } }), applied)
  assert.equal((await client.getView()).state.revision, 4)

  mode = 'partial'
  const partial = await setOp.run(command('partial'), { desktop: () => client })
  assert.equal(partial.structuredContent.status, 'partial')
  assert.equal(partial.isError, true)
  assert.equal(partial.structuredContent.error, undefined)
  assert.ok(setOp.outputSchema.safeParse(partial.structuredContent).success)
  mode = 'no-ack'
  const uncertain = await client.setView(command('no-ack'))
  assert.equal(uncertain.status, 'uncertain')
  assert.match(uncertain.reasons.join(), /timed out/)
  const timeoutSends = sends
  state = { ...state, route: '/', activePanel: 'library', revision: session.getRevision() + 1 }
  session.report(state)
  session.acknowledge({ ...uncertain, status: 'applied', state, revision: state.revision, reasons: [] })
  assert.deepEqual(await client.setView(command('no-ack')), uncertain)
  assert.equal(sends, timeoutSends)
  assert.equal((await client.getView()).state.route, '/')

  const pending = session.command(command('reload-pending'))
  const queued = session.command(command('reload-queued'))
  await Promise.resolve()
  session.reset()
  session.rendererReady()
  state = { ...state, revision: session.getRevision() + 1 }
  session.report(state)
  assert.equal((await pending).status, 'uncertain')
  assert.equal((await queued).status, 'uncertain')
  assert.equal(sends, timeoutSends + 1)

  mode = 'http-timeout'
  const shortClient = new AuroraDesktopClient({ connectionFile, timeoutMs: 80 })
  assert.equal((await shortClient.setView(command('http-timeout'))).status, 'uncertain')
  mode = 'wrong-id'
  assert.equal((await client.setView(command('wrong-ack'))).status, 'uncertain')
  console.log('Agent bridge passed: discovery, auth, protocol/capabilities, applied, stale revision, partial, serialization, duplicate ids, renderer/HTTP timeout, reload and malformed ack; no Electron or provider calls.')
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  console.log(`Isolated test fixture: ${scratch}`)
}
