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
const constantsUrl = moduleUrl(await readFile(new URL('../../aurora/src/shared/constants.ts', import.meta.url), 'utf8'))
const protocolUrl = moduleUrl((await readFile(new URL('../../aurora/src/main/agent/protocol.ts', import.meta.url), 'utf8'))
  .replace("from '@shared/constants'", `from '${constantsUrl}'`))
const protocol = await import(protocolUrl)
const viewSource = await readFile(new URL('../../aurora/src/main/agent/view.ts', import.meta.url), 'utf8')
const { ViewSession } = await import(moduleUrl(viewSource.replace("from './protocol'", `from '${protocolUrl}'`)))
assert.equal(protocol.AGENT_PROTOCOL_VERSION, DESKTOP_PROTOCOL_VERSION)
assert.deepEqual(protocol.AGENT_CAPABILITIES, DESKTOP_CAPABILITIES)
assert.deepEqual(protocol.AGENT_PAGES, DESKTOP_PAGES)
assert.equal(desktopConnectionPath(), join(homedir(), '.aurora', 'agent-connection.json'))

// Execute the renderer registry and view reporter with disposable stores/audio.
function createStore(initializer) {
  const listeners = new Set()
  let state
  const set = (patch) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    for (const listener of listeners) listener(state)
  }
  const get = () => state
  state = initializer(set, get)
  return { getState: get, setState: set, subscribe: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  } }
}
const fixtures = { create: createStore }
globalThis.auroraBridgeFixture = fixtures
const fixtureModule = (names) => moduleUrl(names.map((name) =>
  `export const ${name} = globalThis.auroraBridgeFixture.${name}`).join('\n'))
const storeModule = fixtureModule(['create'])
const readApp = (path) => readFile(new URL(`../../aurora/src/${path}`, import.meta.url), 'utf8')
const loadStore = async (path) => import(moduleUrl((await readApp(path))
  .replace("from 'zustand'", `from '${storeModule}'`).replace("from '@shared/constants'", `from '${constantsUrl}'`)))
const { useComposerStore } = await loadStore('renderer/src/stores/composerStore.ts')
const { usePreviewStore } = await loadStore('renderer/src/stores/previewStore.ts')
fixtures.useComposerStore = useComposerStore
fixtures.usePreviewStore = usePreviewStore
const asset = { id: 'renderer-take', path: 'fixture.wav', name: 'Fixture take', recipe: {} }
fixtures.useProjectStore = createStore((set) => ({
  currentProject: { id: 'initial' }, assets: [], currentAsset: null, currentTrackTab: 'all', tracks: [],
  selectProject: async (id) => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    set({ currentProject: { id }, assets: [asset], currentAsset: null, currentTrackTab: 'all' })
    return { id }
  },
  selectAsset: async (currentAsset) => set({ currentAsset }),
  setCurrentTrackTab: (currentTrackTab) => set({ currentTrackTab })
}))
fixtures.useUIStore = createStore((set, get) => ({
  settings: false, isModalOpen: () => get().settings,
  openModal: () => set({ settings: true }), closeModal: () => set({ settings: false })
}))
fixtures.useAssetSelection = createStore((set) => ({
  mounted: true, ids: new Set(), setSelected: (ids) => set({ ids })
}))
let audioMode = 'play'
class FixtureAudio extends EventTarget {
  currentTime = 0
  duration = 120
  readyState = 1
  paused = true
  ended = false
  play() {
    if (audioMode === 'error') return Promise.reject(new DOMException('Fixture refused', 'NotSupportedError'))
    if (audioMode === 'wait') return Promise.resolve()
    this.paused = false
    setTimeout(() => {
      this.dispatchEvent(new Event('loadedmetadata'))
      this.dispatchEvent(new Event('playing'))
    }, 5)
    return Promise.resolve()
  }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
  removeAttribute() {}
  load() {}
}
globalThis.Audio = FixtureAudio
const reports = []
const acknowledgements = new Map()
let rendererCommand
globalThis.window = { api: {
  getProject: async (id) => id === 'missing' ? null : { id }, agentReady: async () => 0,
  reportAgentView: (state) => reports.push(structuredClone(state)),
  acknowledgeAgentView: (ack) => acknowledgements.get(ack.requestId)?.(ack),
  onAgentViewCommand: (handler) => { rendererCommand = handler; return () => {} }
} }
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0)
fixtures.unavailable = () => { throw new Error('Stem engine must not be touched by preview commands') }
const stemModule = moduleUrl(`
  export const useStemSession = {}, stemState = globalThis.auroraBridgeFixture.unavailable,
    openStemSession = stemState, getLanePlayer = stemState, checkedRange = stemState, updateClock = stemState;
  export const STEM_SAMPLE_RATE = 44100, stemBeatSeconds = stemState;
`)
const storeUrls = Object.fromEntries(['useProjectStore', 'useUIStore', 'useAssetSelection', 'useComposerStore', 'usePreviewStore']
  .map((name) => [name, fixtureModule([name])]))
const rewriteStores = (source) => source
  .replace("from '@/stores/projectStore'", `from '${storeUrls.useProjectStore}'`)
  .replace("from '@/stores/uiStore'", `from '${storeUrls.useUIStore}'`)
  .replace("from './selection'", `from '${storeUrls.useAssetSelection}'`)
  .replace("from '@/stores/composerStore'", `from '${storeUrls.useComposerStore}'`)
  .replace("from '@/stores/previewStore'", `from '${storeUrls.usePreviewStore}'`)
  .replace("from '@shared/constants'", `from '${constantsUrl}'`)
const actionsUrl = moduleUrl(rewriteStores(await readApp('renderer/src/agent/actions.ts'))
  .replace("from '@/stem-view/session'", `from '${stemModule}'`)
  .replace("from '@/stem-view/player'", `from '${stemModule}'`))
let hookIndex = 0
const effects = []
const location = { pathname: '/' }
fixtures.useLayoutEffect = (effect, deps) => {
  const index = hookIndex++
  const prior = effects[index]
  if (prior && deps.every((value, i) => value === prior.deps[i])) return
  prior?.off?.()
  effects[index] = { deps, off: effect() }
}
let rerender
const navigate = (path) => { location.pathname = path; queueMicrotask(() => rerender()) }
fixtures.useLocation = () => location
fixtures.useNavigate = () => navigate
const { useAgentView } = await import(moduleUrl(rewriteStores(await readApp('renderer/src/agent/view.ts'))
  .replace("from 'react'", `from '${fixtureModule(['useLayoutEffect'])}'`)
  .replace("from 'react-router-dom'", `from '${fixtureModule(['useLocation', 'useNavigate'])}'`)
  .replace("from './actions'", `from '${actionsUrl}'`)))
rerender = () => { hookIndex = 0; useAgentView() }
rerender()
await Promise.resolve()
const offComposer = useComposerStore.subscribe((s) => {
  if (s.pending) queueMicrotask(() => useComposerStore.getState().take(s.pending.nonce))
})
const rendererRun = (requestId, patch, timeoutMs = 500) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Missing renderer ack for ${requestId}`)), timeoutMs + 500)
  acknowledgements.set(requestId, (ack) => { clearTimeout(timer); resolve(ack) })
  rendererCommand({ ...protocol.parseViewCommand({ requestId, patch }), expiresAt: Date.now() + timeoutMs })
})
try {
  const switched = await rendererRun('renderer-switch', { projectId: 'next', openAssetId: asset.id, page: 'extract' })
  assert.equal(switched.status, 'applied')
  assert.equal(switched.state.projectId, 'next')
  assert.equal(switched.state.openAssetId, asset.id)
  const refused = await rendererRun('renderer-missing', { projectId: 'missing', openAssetId: null, playback: { action: 'play', assetId: asset.id } })
  assert.equal(refused.status, 'rejected')
  assert.equal(refused.state.openAssetId, asset.id)
  assert.equal(refused.state.playback.playingId, null)
  const played = await rendererRun('renderer-play', { playback: { action: 'play', assetId: asset.id } })
  assert.equal(played.status, 'applied')
  assert.equal(played.state.playback.isPlaying, true)
  assert.equal((await rendererRun('renderer-play-again', { playback: { action: 'play', assetId: asset.id } })).state.playback.isPlaying, true)
  assert.equal((await rendererRun('renderer-seek', { playback: { action: 'seek', seconds: 999 } })).state.playback.positionSeconds, 120)
  const paused = await rendererRun('renderer-pause', { playback: { action: 'pause' } })
  assert.equal(paused.state.playback.isPlaying, false)
  assert.deepEqual(await rendererRun('renderer-play', { playback: { action: 'play', assetId: asset.id } }), played)
  assert.equal(usePreviewStore.getState().isPlaying, false, 'Duplicate ids must not resume playback')
  assert.equal((await rendererRun('renderer-resume', { playback: { action: 'play', assetId: asset.id } })).state.playback.isPlaying, true)
  assert.equal((await rendererRun('renderer-no-asset', { playback: { action: 'play', assetId: 'missing' } })).status, 'rejected')
  usePreviewStore.getState().stop()
  audioMode = 'error'
  const error = await rendererRun('renderer-error', { playback: { action: 'play', assetId: asset.id } })
  assert.equal(error.status, 'partial')
  assert.match(error.state.playback.error, /unsupported/)
  usePreviewStore.getState().stop()
  audioMode = 'wait'
  assert.equal((await rendererRun('renderer-timeout', { playback: { action: 'play', assetId: asset.id } }, 50)).status, 'uncertain')
  usePreviewStore.getState().stop()
  assert.equal((await rendererRun('renderer-empty-seek', { playback: { action: 'seek', seconds: 3 } })).status, 'rejected')
  useComposerStore.getState().setDraft({ prompt: 'Words being written', soundPrompt: 'A bell' })
  assert.equal(reports.at(-1).composerDraft.prompt, 'Words being written')
  const composer = await rendererRun('renderer-composer', { composer: { fromAssetId: asset.id,
    mode: 'prompt', fields: { tab: 'sounds', prompt: 'A chime', model: 'V5_5', weirdness: 0 }, notes: [] } })
  assert.equal(composer.status, 'applied')
  assert.equal(composer.state.composerDraft.prompt, 'Words being written')
  assert.equal(composer.state.composerDraft.soundPrompt, 'A chime')
  assert.equal(composer.state.composerDraft.model, 'V5.5')
  console.log('Renderer bridge passed: awaited project switch, rejected dependencies, preview actions, idempotent play, duplicate acknowledgements, seek clamp, decode failure/timeout and live composer draft.')
} finally {
  usePreviewStore.getState().stop()
  offComposer()
  effects.forEach((effect) => effect.off?.())
  delete globalThis.auroraBridgeFixture
  delete globalThis.Audio
  delete globalThis.window
  delete globalThis.requestAnimationFrame
}

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
  composerDraft: { prompt: 'Fixture lyrics', tab: 'song' },
  playback: { playingId: null, playingName: null, isPlaying: false, isLoading: false,
    positionSeconds: 0, durationSeconds: 120, error: null },
  activePanel: 'library', libraryTrackId: null, revision: 1, observedAt: new Date().toISOString() }
const session = new ViewSession((command) => {
  sends++
  if (mode === 'no-ack') return
  inFlight++
  maxInFlight = Math.max(maxInFlight, inFlight)
  setTimeout(() => {
    state = { ...state, route: command.patch.page === 'extract' ? '/extract' : '/',
      projectId: command.patch.projectId ?? state.projectId,
      playback: command.patch.playback?.action === 'play' ? { ...state.playback,
        playingId: command.patch.playback.assetId, playingName: 'Fixture take', isPlaying: true } :
        command.patch.playback?.action === 'pause' ? { ...state.playback, isPlaying: false } :
          command.patch.playback?.action === 'seek' ? { ...state.playback,
            positionSeconds: Math.min(command.patch.playback.seconds, state.playback.durationSeconds) } : state.playback,
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
const playOp = ALL_OPERATIONS.find((op) => op.id === 'aurora_play')
const pauseOp = ALL_OPERATIONS.find((op) => op.id === 'aurora_pause')
const seekOp = ALL_OPERATIONS.find((op) => op.id === 'aurora_seek')

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

  for (const [field, value] of [['tab', 'bogus'], ['remixVerb', 'bogus'], ['styleWeight', 5],
    ['weirdness', -1], ['audioWeight', NaN], ['variety', 4.5], ['duration', '9999'],
    ['model', 'bogus'], ['soundKey', 'E#'], ['soundTempo', '301']]) {
    assert.throws(() => protocol.parseViewCommand({ requestId: 'invalid-composer', patch: {
      composer: { fromAssetId: 'asset', mode: 'prompt', fields: { [field]: value }, notes: [] }
    } }), undefined, field)
  }
  const validComposer = { fromAssetId: 'asset', mode: 'prompt', fields: {
    tab: 'sounds', remixVerb: 'cover', styleWeight: 0, weirdness: 1, audioWeight: 0.65,
    variety: null, duration: '', model: 'V5_5', soundKey: 'C#m', soundTempo: '300'
  }, notes: [] }
  protocol.parseViewCommand({ requestId: 'valid-composer', patch: { composer: validComposer } })
  for (const playback of [{ action: 'seek', seconds: -1 }, { action: 'seek', seconds: Infinity },
    { action: 'pause', assetId: 'unexpected' }, { action: 'play', assetId: '' }]) {
    assert.throws(() => protocol.parseViewCommand({ requestId: 'invalid-preview', patch: { playback } }))
  }
  const badState = structuredClone(state)
  badState.playback.positionSeconds = NaN
  assert.equal(protocol.isViewState(badState), false)
  const projectSwitch = await setOp.run({ requestId: 'project-switch', patch: { projectId: 'next-project' } }, { desktop: () => client })
  assert.equal(projectSwitch.structuredContent.state.projectId, 'next-project')
  for (const capability of ['project-set', 'composer-load', 'preview-play', 'preview-pause', 'preview-seek']) {
    capabilities = DESKTOP_CAPABILITIES.filter((value) => value !== capability)
    const patch = { projectId: 'next-project', composer: validComposer,
      playback: capability === 'preview-pause' ? { action: 'pause' } : capability === 'preview-seek'
        ? { action: 'seek', seconds: 1 } : { action: 'play', assetId: 'take' } }
    await assert.rejects(client.setView({ requestId: `unsupported-${capability}`, patch }),
      (error) => error.code === 'DESKTOP_CAPABILITY_MISSING')
  }
  capabilities = [...DESKTOP_CAPABILITIES]
  const played = await playOp.run({ requestId: 'play', assetId: 'take' }, { desktop: () => client })
  assert.equal(played.structuredContent.status, 'applied')
  assert.equal(played.structuredContent.state.playback.playingId, 'take')
  assert.equal(played.structuredContent.state.playback.isPlaying, true)
  const playedSends = sends
  assert.deepEqual((await playOp.run({ requestId: 'play', assetId: 'take' }, { desktop: () => client })).structuredContent,
    played.structuredContent)
  assert.equal(sends, playedSends)
  const sought = await seekOp.run({ requestId: 'seek', seconds: 999 }, { desktop: () => client })
  assert.equal(sought.structuredContent.state.playback.positionSeconds, 120)
  const paused = await pauseOp.run({ requestId: 'pause' }, { desktop: () => client })
  assert.equal(paused.structuredContent.state.playback.isPlaying, false)
  const read = await getOp.run({}, { desktop: () => client })
  assert.equal(read.structuredContent.state.composerDraft.prompt, 'Fixture lyrics')
  assert.equal(read.structuredContent.state.playback.positionSeconds, 120)

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
  console.log('Agent bridge passed: discovery, auth, protocol/capabilities, project switch, composer ranges/read-back, play/pause/seek, applied, stale revision, partial, serialization, duplicate ids, renderer/HTTP timeout, reload and malformed ack; no Electron or provider calls.')
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  console.log(`Isolated test fixture: ${scratch}`)
}
