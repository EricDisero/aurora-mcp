// Free v8 migration, storage and tool checks. All writes use a temporary library; fetch is forbidden.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

const scratch = await mkdtemp(join(tmpdir(), 'aurora-recipes-'))
const previousUserData = process.env.AURORA_USER_DATA
process.env.AURORA_USER_DATA = join(scratch, 'user-data')
const originalFetch = globalThis.fetch
let networkAttempts = 0
globalThis.fetch = async () => { networkAttempts++; throw new Error('Recipe tests forbid every network request') }
const { getDb, closeDb, backfillRecipes } = await import('../packages/shared/dist/db.js')
const { createProject } = await import('../packages/shared/dist/storage/projects.js')
const { getAsset, insertAsset } = await import('../packages/shared/dist/storage/assets.js')
const { getStems, upsertStem } = await import('../packages/shared/dist/storage/stems.js')
const { getExtractionStems, upsertExtractionStem } = await import('../packages/shared/dist/storage/extractions.js')
const { listStoredSets, createStemSet } = await import('../packages/shared/dist/storage/stem-sets.js')
const { ALL_OPERATIONS } = await import('../packages/shared/dist/operations/index.js')
const { AuroraDesktopClient } = await import('../packages/shared/dist/clients/desktop.js')
const { generationRecipe, localRecipe } = await import('../packages/shared/dist/recipe.js')
const { DEFAULT_SUNO_MODEL } = await import('../packages/shared/dist/providers/suno.js')
const offline = { desktop: () => new AuroraDesktopClient({ connectionFile: join(scratch, 'not-connected.json') }) }

async function call(id, input, context = offline, error) {
  const op = ALL_OPERATIONS.find((op) => op.id === id)
  assert.ok(op, id)
  const result = await op.run(input, context)
  assert.ok(op.outputSchema.safeParse(result.structuredContent).success, `${id}: output schema`)
  if (error) assert.equal(result.isError, true, `${id} must refuse`)
  else assert.notEqual(result.isError, true, `${id}: ${result.text}`)
  return result.structuredContent
}

try {
  const project = await createProject('Recipe fixture')
  let db = getDb()
  assert.equal(db.pragma('user_version', { simple: true }), 8)
  const audio = join(scratch, 'input.wav')
  // A real local WAV also supports import/stem registration checks below.
  const { encodeWavFloat32File } = await import('../packages/shared/dist/audio/wav.js')
  await encodeWavFloat32File(audio, [new Float32Array(4410), new Float32Array(4410)], 44100)
  const now = 1700000000000
  const origin = { provider: 'sunoapi', prompt: '[Verse]\nKeep these exact words', style: 'dark cinematic choir',
    title: 'Fixture song', model: DEFAULT_SUNO_MODEL, customMode: true, instrumental: false,
    styleWeight: 0.65, weirdnessConstraint: 0.3, taskId: 'legacy-task', audioId: 'legacy-audio' }
  const insert = db.prepare(`INSERT INTO project_assets
    (id, project_id, kind, name, path, origin, source_asset_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const [id, kind, meta, source] of [
    ['generation', 'generation', origin, null],
    ['sound', 'generation', { ...origin, prompt: 'Deep braam', soundKey: 'Cm', soundTempo: 92, soundLoop: true }, null],
    ['cover', 'cover', { ...origin, title: 'Fixture cover' }, 'generation'],
    ['import', 'track', null, null],
    ['master', 'master', null, 'generation']
  ]) insert.run(id, project.id, kind, id, audio, meta ? JSON.stringify(meta) : null, source, now)
  for (const [id, key, source] of [['mvsep', 'vocals', 'mvsep'], ['synthesized', 'hats', 'synthesized'], ['imported', 'kick', 'imported']]) {
    db.prepare(`INSERT INTO project_stems (id, project_id, asset_id, stem_type, path, origin)
      VALUES (?, ?, 'generation', ?, ?, ?)`).run(id, project.id, key, audio, source)
  }
  db.prepare(`INSERT INTO extraction_stems (id, project_id, asset_id, stem_id, path, created_at)
    VALUES ('extraction', ?, 'generation', 'piano', ?, ?)`).run(project.id, audio, now)
  const jobPath = join(scratch, 'job.json')
  db.prepare(`INSERT INTO stem_sets (id, project_id, asset_id, kind, name, source_path, created_at)
    VALUES ('import-set', ?, 'generation', 'import', 'Imported set', ?, ?)`).run(project.id, jobPath, now)
  const recordedJobPath = join(scratch, 'recorded-job.json')
  await writeFile(recordedJobPath, JSON.stringify({ command: 'split', status: 'ok',
    args: { input: audio, out: scratch, mode: 'drums', bass: true }, taskIds: { drumsepJobHash: 'fixture-only' } }))
  db.prepare(`INSERT INTO stem_sets (id, project_id, asset_id, kind, name, source_path, created_at)
    VALUES ('recorded-import-set', ?, 'generation', 'import', 'Recorded imported set', ?, ?)`)
    .run(project.id, recordedJobPath, now)
  for (const table of ['project_assets', 'project_stems', 'extraction_stems', 'stem_sets']) {
    assert.ok(db.prepare(`SELECT recipe FROM ${table}`).all().every((row) => row.recipe === null))
  }
  backfillRecipes(db)
  const expectedAssets = {
    generation: ['generate', [], []],
    sound: ['sounds', [], []],
    cover: ['cover', [{ relation: 'cover-of', assetId: 'generation' }], ['which Suno operation (read as cover)']],
    import: ['import', [], ['the original file path']],
    master: ['master', [{ relation: 'mastered-from', assetId: 'generation' }], ['the reference', 'the mastering settings']]
  }
  for (const [id, [operation, lineage, missing]] of Object.entries(expectedAssets)) {
    const recipe = getAsset(id).recipe
    assert.equal(recipe.operation, operation, id)
    assert.deepEqual(recipe.lineage, lineage, id)
    assert.deepEqual(recipe.missing, missing, id)
    assert.equal(recipe.recordedBy, 'backfill')
    assert.equal(recipe.createdAt, now)
  }
  for (const [id, operation, relation, missing] of [
    ['mvsep', 'split', 'split-from', ['the separation route and model']],
    ['synthesized', 'split', 'split-from', []],
    ['imported', 'stem-import', 'stems-of', ['the original file path']]
  ]) {
    const recipe = getStems('generation').find((stem) => stem.id === id).recipe
    assert.equal(recipe.operation, operation)
    assert.deepEqual(recipe.lineage, [{ relation, assetId: 'generation' }])
    assert.deepEqual(recipe.missing, missing)
  }
  const extracted = getExtractionStems('generation')[0].recipe
  assert.equal(extracted.operation, 'extract')
  assert.deepEqual(extracted.lineage, [{ relation: 'extracted-from', assetId: 'generation' }])
  assert.deepEqual(extracted.missing, ['the separation route and model'])
  const setRecipe = listStoredSets('generation')[0].recipe
  assert.equal(setRecipe.operation, 'stem-import')
  assert.deepEqual(setRecipe.lineage, [{ relation: 'stems-of', assetId: 'generation' }])
  assert.deepEqual(setRecipe.inputs, [{ role: 'upload', path: jobPath }])
  assert.deepEqual(setRecipe.missing, ['the split route that made the files'])
  const recoveredJob = listStoredSets('generation').find((set) => set.id === 'recorded-import-set').recipe
  assert.equal(recoveredJob.operation, 'stem-import')
  assert.equal(recoveredJob.provider, 'mvsep')
  assert.deepEqual(recoveredJob.lineage, [{ relation: 'stems-of', assetId: 'generation' }])
  assert.deepEqual(recoveredJob.settings, { mode: 'drums', bass: true, jobs: ['drumsep'] })
  assert.deepEqual(recoveredJob.missing, [])
  const snapshot = () => ['project_assets', 'project_stems', 'extraction_stems', 'stem_sets']
    .map((table) => db.prepare(`SELECT id, recipe FROM ${table} ORDER BY id`).all())
  const before = snapshot()
  backfillRecipes(db)
  assert.deepEqual(snapshot(), before, 'backfill must preserve existing recipes')
  console.log('PASS all legacy operations, lineage, missing facts and idempotent backfill')

  // Exercise the migration itself, starting from the same rows without v8 columns.
  for (const table of ['project_assets', 'project_stems', 'extraction_stems', 'stem_sets']) db.exec(`ALTER TABLE ${table} DROP COLUMN recipe`)
  db.pragma('user_version = 7')
  closeDb()
  db = getDb()
  assert.equal(db.pragma('user_version', { simple: true }), 8)
  assert.deepEqual(snapshot(), before, 'v7 -> v8 must produce the same recipes')
  console.log('PASS fresh DB and actual v7 -> v8 migration')

  const generation = await call('aurora_get_recipe', { assetId: 'generation' })
  assert.equal(generation.subject.type, 'asset')
  assert.equal(generation.recipe.prompt, origin.prompt)
  assert.equal(generation.refusal, null)
  assert.equal(generation.reusableFrom, 'generation')
  const stem = await call('aurora_get_recipe', { stemId: 'mvsep' })
  assert.equal(stem.subject.type, 'stem')
  assert.equal(stem.recipe.operation, 'split')
  assert.equal(stem.reusableFrom, 'generation')
  assert.equal((await call('aurora_get_recipe', { stemId: 'extraction' })).subject.type, 'extraction')
  assert.equal((await call('aurora_get_recipe', { stemId: 'import-set' })).subject.type, 'stemSet')
  const copied = await call('aurora_copy_recipe', { assetId: 'generation' })
  assert.deepEqual(Object.keys(copied), ['text'])
  assert.equal(copied.text, generation.text)
  assert.ok(copied.text.includes(origin.prompt))
  await call('aurora_get_recipe', {}, offline, true)
  await call('aurora_get_recipe', { assetId: 'generation', stemId: 'mvsep' }, offline, true)
  await call('aurora_get_recipe', { stemId: 'missing' }, offline, true)
  await call('aurora_reuse_prompt', { assetId: 'import' }, offline, true)
  const prompt = await call('aurora_reuse_prompt', { assetId: 'generation' })
  assert.equal(prompt.loaded, false)
  assert.match(prompt.reason, /not connected/)
  assert.equal(prompt.call.op, 'aurora_generate')
  assert.equal(prompt.call.args.prompt, origin.prompt)
  assert.equal(prompt.fields.style, origin.style)
  const reference = await call('aurora_reuse_reference', { assetId: 'cover' })
  assert.equal(reference.loaded, false)
  assert.equal(reference.call.op, 'aurora_cover')
  assert.equal(reference.call.args.sourceAssetId, 'generation')
  const coverPrompt = await call('aurora_reuse_prompt', { assetId: 'cover', loadInApp: false })
  assert.equal(coverPrompt.call.op, 'aurora_generate')
  assert.equal(coverPrompt.call.args.sourceAssetId, undefined)
  assert.equal((await call('aurora_reuse_prompt', { assetId: 'master' })).call.args.prompt, origin.prompt)
  const sound = await call('aurora_reuse_reference', { assetId: 'sound', loadInApp: false })
  assert.equal(sound.call.op, 'aurora_sounds')
  assert.equal(sound.call.args.tempo, 92)
  assert.equal(sound.call.args.loop, true)
  for (const [operation, params, extras, op, verify] of [
    ['replace-section', { ...origin, style: undefined, tags: 'cinematic', infillStartS: 10, infillEndS: 30, fullLyrics: origin.prompt },
      { sourceAssetId: 'generation' }, 'aurora_replace_section', (args) => {
        assert.equal(args.startS, 10); assert.equal(args.endS, 30); assert.equal(args.tags, 'cinematic')
      }],
    ['mashup', origin, { sourceAssetId: 'generation', sourcePathB: audio }, 'aurora_mashup', (args) => {
      assert.equal(args.sourceAssetIdA, 'generation'); assert.equal(args.sourcePathB, audio)
    }],
    ['generate', { ...origin, model: 'unavailable-model' }, {}, 'aurora_generate', (args) => assert.equal(args.model, DEFAULT_SUNO_MODEL)]
  ]) {
    const asset = insertAsset({ projectId: project.id, kind: 'generation', name: operation, path: audio,
      recipe: generationRecipe({ operation, params, recordedBy: 'mcp', ...extras }) })
    const reuse = await call('aurora_reuse_reference', { assetId: asset.id, loadInApp: false })
    assert.equal(reuse.call.op, op)
    assert.ok(ALL_OPERATIONS.find((target) => target.id === op).input.safeParse(reuse.call.args).success)
    verify(reuse.call.args)
  }
  const plan = await call('aurora_make_variations', { assetId: 'cover', count: 3 })
  assert.equal(plan.planned, 3)
  assert.equal(plan.call.op, 'aurora_cover')
  assert.equal(plan.call.args.sourceAssetId, 'generation')
  assert.equal(plan.estimatedCredits.length, 3)
  assert.ok(plan.estimatedCredits.every((credit) => credit.amount === 12))
  assert.equal(plan.note, 'Pass confirm: true to run')
  await call('aurora_make_variations', { assetId: 'cover', count: 6 }, offline, true)
  console.log('PASS five tools, all subject tables, refusal, lineage reuse, exact words and free variation plan')

  // Return a typed desktop ack without opening a socket or touching real discovery data.
  const state = { route: '/', projectId: project.id, openAssetId: null, selectedAssetIds: [], activePanel: 'create',
    libraryTrackId: null, revision: 2, observedAt: new Date().toISOString() }
  let command
  const desktop = { desktop: () => ({ async setView(input) {
    command = input
    return { connected: true, requestId: input.requestId, status: 'applied', state, revision: 2, reasons: [] }
  } }) }
  const loaded = await call('aurora_reuse_reference', { assetId: 'cover' }, desktop)
  assert.equal(loaded.loaded, true)
  assert.equal(loaded.acknowledgement.status, 'applied')
  assert.equal(command.patch.page, 'create')
  assert.deepEqual(command.patch.composer, { fromAssetId: 'cover', mode: 'reference', fields: reference.fields, notes: reference.notes })
  await call('aurora_reuse_prompt', { assetId: 'master' }, desktop)
  assert.equal(command.patch.composer.fromAssetId, 'generation')
  const oldConnection = join(scratch, 'old-connection.json')
  await writeFile(oldConnection, JSON.stringify({ port: 12345, token: 'x'.repeat(32), pid: process.pid,
    appVersion: 'fixture', protocolVersion: 1, capabilities: ['view', 'view-set', 'request-ack'] }))
  const unsupported = await call('aurora_reuse_prompt', { assetId: 'generation' },
    { desktop: () => new AuroraDesktopClient({ connectionFile: oldConnection }) })
  assert.equal(unsupported.loaded, false)
  assert.match(unsupported.reason, /composer-load/)
  console.log('PASS composer contract, acknowledgement, ancestor id and capability refusal before network')

  // Confirmed dispatch is tested with the target run replaced; no provider code is entered.
  const target = ALL_OPERATIONS.find((op) => op.id === 'aurora_cover')
  const realRun = target.run
  const dispatches = []
  try {
    target.run = async (args) => { dispatches.push(args); return { text: 'fake job', data: {}, structuredContent: { jobId: 'fake' } } }
    const results = await call('aurora_make_variations', { assetId: 'cover', count: 2, confirm: true })
    assert.equal(results.results.length, 2)
    assert.equal(dispatches.length, 2)
    assert.ok(dispatches.every((args) => args.background === true && args.sourceAssetId === 'generation' && args.prompt === origin.prompt))
    target.run = async () => ({ text: 'fake refusal', data: {}, structuredContent: {}, isError: true })
    const refused = await call('aurora_make_variations', { assetId: 'cover', count: 5, confirm: true }, offline, true)
    assert.equal(refused.results.length, 1, 'failure stops subsequent calls')
  } finally { target.run = realRun }
  console.log('PASS confirmed dispatch uses target run, background mode and stops after failure (stubbed, free)')

  // Inserts preserve explicit recipes; old/null columns still have read fallbacks without writes.
  const recipe = localRecipe({ operation: 'convert', recordedBy: 'mcp', fromAssetId: 'generation', settings: { to: 'wav' } })
  const fresh = insertAsset({ projectId: project.id, kind: 'track', name: 'Conversion', path: audio, recipe })
  assert.deepEqual(getAsset(fresh.id).recipe, recipe)
  const splitRecipe = localRecipe({ operation: 'split', recordedBy: 'mcp', provider: 'mvsep', fromAssetId: 'generation', settings: { routeId: 'split-vocals' } })
  assert.deepEqual(upsertStem({ projectId: project.id, assetId: 'generation', stemType: 'vocals', path: audio, origin: 'mvsep', recipe: splitRecipe }).recipe, splitRecipe)
  assert.deepEqual(upsertExtractionStem({ projectId: project.id, assetId: 'generation', stemId: 'piano', path: audio, detectedKey: null, recipe: splitRecipe }).recipe, splitRecipe)
  const custom = createStemSet({ projectId: project.id, assetId: 'generation', name: 'Recipe set', kind: 'custom',
    lanes: [{ stemKey: 'piano', label: 'Piano', path: audio }], recipe })
  assert.deepEqual(custom.recipe, recipe)
  for (const [table, id] of [['project_assets', 'import'], ['project_stems', 'imported'], ['extraction_stems', 'extraction'], ['stem_sets', 'import-set']]) {
    db.prepare(`UPDATE ${table} SET recipe = NULL WHERE id = ?`).run(id)
  }
  assert.equal(getAsset('import').recipe.operation, 'import')
  assert.equal(getStems('generation').find((stem) => stem.id === 'imported').recipe.operation, 'stem-import')
  assert.equal(getExtractionStems('generation')[0].recipe.operation, 'extract')
  assert.equal(listStoredSets('generation')[0].recipe.operation, 'stem-import')
  const imported = await call('aurora_import_file', { projectId: project.id, filePath: audio })
  assert.equal(imported.asset.recipe.recordedBy, 'mcp')
  assert.deepEqual(imported.asset.recipe.inputs, [{ role: 'upload', path: audio, name: 'input.wav' }])
  assert.equal(imported.asset.recipe.settings.standardizedTo, 'wav 44.1 kHz stereo float32')
  const toolSet = await call('aurora_create_stem_set', { assetId: 'generation', name: 'Custom', lanes: [{ stemKey: 'piano', path: audio }] })
  assert.equal(toolSet.set.recipe.operation, 'stem-set')
  assert.deepEqual(toolSet.set.recipe.settings.lanes, ['piano'])
  assert.equal(toolSet.set.recipe.inputs[0].path, audio)
  console.log('PASS explicit recipe persistence, read fallbacks, standardized import and custom set landings')

  const shifted = await call('aurora_pitch_shift', { assetId: 'generation', semitones: 0, preserveTempo: false, format: 'wav' })
  assert.equal(shifted.asset.recipe.operation, 'pitch-shift')
  assert.deepEqual(shifted.asset.recipe.settings, { semitones: 0, preserveTempo: false, format: 'wav', engine: shifted.engine })
  const converted = await call('aurora_convert', { assetId: 'generation', to: 'wav' })
  assert.equal(converted.asset.recipe.operation, 'convert')
  assert.deepEqual(converted.asset.recipe.lineage, [{ relation: 'derived-from', assetId: 'generation' }])

  // The finalization paths are local: exercise real route recovery and Other synthesis without fetching.
  const { finalizeExtract } = await import('../packages/shared/dist/extract.js')
  const { finalizeSplit } = await import('../packages/shared/dist/split.js')
  const { ALL_ROUTES } = await import('../packages/shared/dist/separation/routes.js')
  const extractsDir = join(scratch, 'extracts')
  await mkdir(extractsDir)
  const derivedAsset = insertAsset({ projectId: project.id, kind: 'generation', name: 'Local finalization', path: audio })
  const route = ALL_ROUTES.piano
  const extractState = { assetId: derivedAsset.id, extractDir: extractsDir, originalPath: audio,
    calls: [{ type: 'individual', id: 'piano', routeId: route.id, inputSource: 'original', outputType: 'piano', credits: 2.5 }],
    callIndex: 1, currentHash: null, vocalDryPath: null, extractedFiles: { piano: audio }, detectedKey: null, failures: [] }
  const outputs = await finalizeExtract(derivedAsset, extractState)
  const paidRecipe = outputs.find((row) => row.stemId === 'piano').recipe
  assert.equal(paidRecipe.settings.routeId, route.id)
  assert.equal(paidRecipe.settings.sep_type, String(route.sepType))
  assert.equal(paidRecipe.settings.output_format, '4')
  assert.equal(paidRecipe.modelVersion, route.options.add_opt1)
  assert.deepEqual(paidRecipe.credits, { provider: 'mvsep', amount: 2.5, unit: 'mvsep-minutes', basis: 'estimate' })
  const remainder = outputs.find((row) => row.stemId === 'other').recipe
  assert.equal(remainder.provider, 'local')
  assert.ok(remainder.settings.derived)
  assert.deepEqual(remainder.credits, { provider: 'local', amount: 0, unit: 'none', basis: 'none' })
  await finalizeExtract(derivedAsset, extractState)
  assert.deepEqual(getExtractionStems(derivedAsset.id).find((row) => row.stemId === 'piano').recipe, paidRecipe,
    'finalization must preserve the landed provider recipe')
  const stemsDir = join(scratch, 'split')
  await mkdir(stemsDir)
  for (const name of ['original', 'vocals', 'drums-bus', 'bass']) {
    await encodeWavFloat32File(join(stemsDir, `${name}.wav`), [new Float32Array(4410), new Float32Array(4410)], 44100)
  }
  const other = await finalizeSplit(derivedAsset, stemsDir)
  assert.equal(other.recipe.operation, 'split')
  assert.equal(other.recipe.provider, 'local')
  assert.equal(other.recipe.credits.amount, 0)
  assert.ok(other.recipe.settings.derived)
  console.log('PASS pitch/convert settings, extraction route/options/estimate preservation and free synthesized Other')

  const bridgePath = join(scratch, 'bridge-job.json')
  const bridge = { command: 'split', status: 'ok', args: { input: audio, mode: 'drums', bass: true },
    routes: ['split-drumsep'], options: { add_opt1: '7' }, taskIds: { drums: 'fixture-only' }, finishedAt: 'fixture-time',
    outputs: ['kick', 'snare', 'hats', 'bass', 'other'].map((label) => ({ label, path: audio })) }
  await writeFile(bridgePath, JSON.stringify(bridge))
  const importedSet = await call('aurora_import_split_job', { assetId: derivedAsset.id, jobJsonPath: bridgePath })
  assert.equal(importedSet.set.recipe.operation, 'stem-import')
  assert.equal(importedSet.set.recipe.recordedBy, 'mcp')
  assert.equal(importedSet.set.recipe.provider, 'mvsep')
  assert.deepEqual(importedSet.set.recipe.inputs, [{ role: 'upload', path: bridgePath }])
  assert.deepEqual(importedSet.set.recipe.settings, { mode: 'drums', bass: true, jobs: ['drums'],
    routes: bridge.routes, options: bridge.options })
  console.log('PASS bridge import records mode, routes, options and job provenance')

  // Review fixes (2026-10-07): legacy MCP `op` origins, dotted vs underscored model ids, settings Create cannot restore.
  const { deriveAssetRecipe, reusePlan } = await import('../packages/shared/dist/recipe.js')
  const vocals = deriveAssetRecipe({ kind: 'generation', origin: { provider: 'sunoapi', op: 'add_vocals', prompt: 'la', style: 'choir', model: 'V5_5' }, sourceAssetId: 'src-1', createdAt: 1 })
  assert.equal(vocals.operation, 'add-vocals')
  assert.deepEqual(vocals.lineage, [{ relation: 'layered-on', assetId: 'src-1' }])
  const mash = deriveAssetRecipe({ kind: 'cover', origin: { provider: 'sunoapi', op: 'mashup', prompt: '', model: 'V5', sourceB: 'asset-b' }, sourceAssetId: 'asset-a', createdAt: 1 })
  assert.equal(mash.operation, 'mashup')
  assert.ok(mash.inputs.some((i) => i.role === 'mashup-b' && i.assetId === 'asset-b'))
  const vocalsPlan = reusePlan(vocals, { withReference: false, knownModels: ['V6', 'V5.5'], fallbackModel: 'V6' })
  assert.equal(vocalsPlan.fields.model, 'V5.5')
  assert.ok(!vocalsPlan.notes.some((n) => n.includes('no longer offers')))
  const song = deriveAssetRecipe({ kind: 'generation', origin: { provider: 'sunoapi', prompt: '', style: 'x', model: 'V6', duration: 42, variety: 0 }, createdAt: 1 })
  const songPlan = reusePlan(song, { withReference: false, knownModels: ['V6'], fallbackModel: 'V6' })
  assert.ok(songPlan.notes.some((n) => n.includes('duration') && n.includes('variety')))
  assert.equal(songPlan.call.args.duration, 42)
  console.log('PASS legacy op origins, dotted model match and named unrestorable settings')
  assert.equal(networkAttempts, 0)
  console.log('Recipe tests passed; no provider/network calls or real user data')
} finally {
  closeDb()
  globalThis.fetch = originalFetch
  if (previousUserData === undefined) delete process.env.AURORA_USER_DATA
  else process.env.AURORA_USER_DATA = previousUserData
  const withinTemp = relative(resolve(tmpdir()), resolve(scratch))
  assert.ok(withinTemp && withinTemp !== '..' && !withinTemp.startsWith(`..${sep}`) && !withinTemp.startsWith(sep))
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
