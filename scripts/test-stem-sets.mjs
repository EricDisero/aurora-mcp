// Free storage/read/import checks. Every write stays inside a fresh temporary library.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scratch = await mkdtemp(join(tmpdir(), 'aurora-stem-sets-'))
const previousUserData = process.env.AURORA_USER_DATA
process.env.AURORA_USER_DATA = join(scratch, 'user-data')
const originalFetch = globalThis.fetch
let networkAttempts = 0
globalThis.fetch = async () => { networkAttempts++; throw new Error('Stem set tests forbid network calls') }
const { getDb, closeDb } = await import('../packages/shared/dist/db.js')
const { createProject, getProjectDirectory } = await import('../packages/shared/dist/storage/projects.js')
const { createTrack, getTrackDirectory, getTrack, deleteTrack } = await import('../packages/shared/dist/storage/tracks.js')
const { insertAsset, getAssetStemsDir, getAssetExtractsDir, setAssetTrack, deleteAsset } =
  await import('../packages/shared/dist/storage/assets.js')
const { createStemSet, listStoredSets, deleteStemSet } = await import('../packages/shared/dist/storage/stem-sets.js')
const { getStemView } = await import('../packages/shared/dist/storage/stem-view.js')
const { importSplitJob } = await import('../packages/shared/dist/ingest/split-job.js')
const { ALL_OPERATIONS } = await import('../packages/shared/dist/operations/index.js')

async function wav(path) {
  const bytes = Buffer.alloc(48)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(176400, 28)
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(32, 34); bytes.write('data', 36)
  bytes.writeUInt32LE(4, 40)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  return path
}

const canonical = ['vocals', 'bass', 'kick', 'snare', 'hats', 'toms', 'other']
async function manifest(name, labels, input, status = 'done', folder = join(scratch, 'bridge', name)) {
  const outputs = []
  for (const label of labels) outputs.push({ label, path: await wav(join(folder, 'stems', `${label}.wav`)) })
  const data = { command: 'split', status, args: { input }, outputs }
  const path = join(folder, 'job.json')
  await writeFile(path, JSON.stringify(data))
  return { path, data }
}

async function call(id, input, expectedError) {
  const op = ALL_OPERATIONS.find((op) => op.id === id)
  assert.ok(op, id)
  const result = await op.run(input)
  assert.ok(op.outputSchema.safeParse(result.structuredContent).success, `${id}: output schema`)
  if (expectedError) assert.equal(result.structuredContent.error?.code, expectedError)
  else assert.notEqual(result.isError, true, `${id}: ${result.text}`)
  return result.structuredContent
}

try {
  const project = await createProject('Stem sets fixture')
  const input = await wav(join(scratch, 'input.wav'))
  const asset = insertAsset({ projectId: project.id, kind: 'track', name: 'Fixture', path: input })
  assert.deepEqual(getStemView(asset.id).sets, [])
  assert.equal(getStemView(asset.id).asset.trackId, null)
  assert.throws(() => getStemView('missing-asset'), /Asset not found/)
  const db = getDb()
  for (const stemKey of [...canonical].reverse()) {
    const path = await wav(join(scratch, 'derived-split', `${stemKey}.wav`))
    db.prepare(`INSERT INTO project_stems (id, project_id, asset_id, stem_type, path, origin)
      VALUES (?, ?, ?, ?, ?, 'imported')`).run(randomUUID(), project.id, asset.id, stemKey, path)
  }
  const extractKeys = ['other', 'synth', 'piano', 'guitar_lead', 'drum_cymbals_ride', 'drum_cymbals_crash',
    'drum_toms', 'drum_hihats', 'drum_snare', 'drum_kick', 'bass', 'vocal_lead', 'drum_unknown']
  for (const stemKey of extractKeys) {
    const path = stemKey === 'synth' ? join(scratch, 'unavailable.wav') :
      await wav(join(scratch, 'derived-extract', `${stemKey}.wav`))
    db.prepare(`INSERT INTO extraction_stems (id, project_id, asset_id, stem_id, path, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), project.id, asset.id, stemKey, path, Date.now())
  }
  const view = getStemView(asset.id)
  assert.deepEqual(view.sets.map((set) => set.key), ['split', 'extraction'])
  assert.deepEqual(view.sets[0].lanes.map((lane) => lane.stemKey), canonical)
  assert.deepEqual(view.sets[0].lanes.map((lane) => lane.group), [null, null, 'drums', 'drums', 'drums', 'drums', null])
  assert.deepEqual(view.sets[1].lanes.map((lane) => lane.stemKey), ['bass', 'drum_kick', 'drum_snare',
    'drum_hihats', 'drum_toms', 'drum_cymbals_crash', 'drum_cymbals_ride', 'drum_unknown',
    'vocal_lead', 'guitar_lead', 'piano', 'synth', 'other'])
  for (const set of view.sets) for (const [index, lane] of set.lanes.entries()) {
    assert.equal(lane.laneId, `${set.key}:${lane.stemKey}`)
    assert.equal(lane.sortOrder, index)
    assert.equal(lane.group, lane.stemKey.startsWith('drum_') || ['kick', 'snare', 'toms', 'hats'].includes(lane.stemKey) ? 'drums' : null)
    assert.equal(lane.available, lane.stemKey !== 'synth')
  }
  assert.equal(view.sets[0].lanes.at(-1).label, 'Other')
  assert.equal(view.sets[1].lanes.find((lane) => lane.stemKey === 'vocal_lead').label, 'Lead Vocal')
  const latestPiano = await wav(join(scratch, 'piano-latest.wav'))
  db.prepare('UPDATE extraction_stems SET path = ?, created_at = ? WHERE asset_id = ? AND stem_id = ?')
    .run(latestPiano, Date.now(), asset.id, 'piano')
  assert.equal(getStemView(asset.id).sets[1].lanes.find((lane) => lane.stemKey === 'piano').path, latestPiano)
  console.log('PASS derived split/extraction order, groups, labels, availability and latest paths')

  const setParams = { projectId: project.id, assetId: asset.id, kind: 'custom', name: 'Hand made' }
  const missing = join(scratch, 'missing.wav')
  assert.throws(() => createStemSet({ ...setParams, lanes: [{ stemKey: 'piano', label: 'Piano', path: missing }] }),
    (error) => error.message.includes(missing))
  assert.throws(() => createStemSet({ ...setParams, lanes: [{ stemKey: 'piano', label: 'Piano', path: 'relative.wav' }] }), /absolute/)
  assert.deepEqual(listStoredSets(asset.id), [])
  assert.throws(() => createStemSet({ ...setParams, lanes: [
    { stemKey: 'valid', label: 'Valid', path: input }, { stemKey: 'missing', label: 'Missing', path: missing }
  ] }), /not found/)
  assert.deepEqual(listStoredSets(asset.id), [], 'A failed create must leave no set or partial lanes')
  const customFiles = [await wav(join(scratch, 'custom', 'other.wav')), await wav(join(scratch, 'custom', 'piano.wav'))]
  const custom = createStemSet({ ...setParams, lanes: [
    { stemKey: 'other', label: 'Remainder', path: customFiles[0] },
    { stemKey: 'piano', label: 'My piano', path: customFiles[1] }
  ] })
  const customView = getStemView(asset.id).sets[2]
  assert.deepEqual(customView.lanes.map((lane) => lane.stemKey), ['piano', 'other'])
  assert.deepEqual(customView.lanes.map((lane) => lane.sortOrder), [1, 0])
  assert.equal(customView.lanes[1].label, 'Remainder')
  console.log('PASS custom order, stored labels and missing/relative file refusal')

  const legacy = await manifest('legacy', [...canonical, 'ee', 'original', 'instrumental', 'crash', 'ride'], input, 'ok')
  if (process.platform === 'win32') {
    legacy.data.args.input = input.toUpperCase().replaceAll('\\', '/')
    await writeFile(legacy.path, JSON.stringify(legacy.data))
  }
  const imported = await importSplitJob({ jobJsonPath: legacy.path })
  assert.equal(imported.reused, false)
  assert.equal(imported.set.assetId, asset.id)
  assert.deepEqual(imported.set.lanes.map((lane) => lane.stemKey), canonical)
  assert.equal(imported.set.lanes.at(-1).path, legacy.data.outputs.find((output) => output.label === 'ee').path)
  assert.deepEqual(imported.skipped.map((output) => output.label), ['other', 'original', 'instrumental', 'crash', 'ride'])
  assert.ok(imported.skipped.every((output) => output.reason.length > 0))
  const again = await importSplitJob({ jobJsonPath: legacy.path, assetId: asset.id })
  assert.equal(again.reused, true)
  assert.equal(again.set.id, imported.set.id)
  const concurrent = await Promise.all([importSplitJob({ jobJsonPath: legacy.path }), importSplitJob({ jobJsonPath: legacy.path })])
  assert.ok(concurrent.every((result) => result.reused && result.set.id === imported.set.id))
  if (process.platform === 'win32') {
    assert.equal((await importSplitJob({ jobJsonPath: legacy.path.toUpperCase().replaceAll('\\', '/'), assetId: asset.id })).set.id, imported.set.id)
  }
  const current = await manifest('current', canonical, input)
  const currentSet = await importSplitJob({ jobJsonPath: current.path, assetId: asset.id, name: 'Current' })
  assert.equal(currentSet.set.lanes.at(-1).path, current.data.outputs.find((output) => output.label === 'other').path)
  assert.deepEqual(currentSet.skipped, [])
  for (const [name, data, pattern] of [
    ['unfinished', { ...current.data, status: 'waiting' }, /not done/],
    ['wrong-command', { ...current.data, command: 'cover' }, /command.*split/],
    ['missing-output', { ...current.data, outputs: [...current.data.outputs, { label: 'original', path: missing }] }, /not found/],
    ['incomplete', { ...current.data, outputs: current.data.outputs.filter((output) => output.label !== 'bass') }, /missing canonical output: bass/],
    ['no-match', { ...current.data, args: { input: join(scratch, 'unknown-input.wav') } }, /matches split input/]
  ]) {
    const path = join(scratch, `${name}.json`)
    await writeFile(path, JSON.stringify(data))
    await assert.rejects(importSplitJob({ jobJsonPath: path }), pattern)
  }
  console.log('PASS bridge legacy/current Other, skipped outputs, duplicate reuse and invalid manifests')

  const realPath = 'C:/Users/Eric/AppData/Roaming/aurora/projects/untitled-project-2/track-7/splits/20261006-085049-t7-ambient-drone-a-4-v6-v1/job.json'
  const snapshot = join(dirname(fileURLToPath(import.meta.url)), 'stem-sets-fixture.json')
  const useReal = !process.argv.includes('--snapshot') && existsSync(realPath)
  const real = JSON.parse(await readFile(useReal ? realPath : snapshot, 'utf8'))
  real.args.input = input
  for (const output of real.outputs) output.path = await wav(join(scratch, 'real-copy', 'stems', `${output.label}.wav`))
  const copiedJob = join(scratch, 'real-copy', 'job.json')
  await writeFile(copiedJob, JSON.stringify(real))
  const realImport = await importSplitJob({ jobJsonPath: copiedJob })
  assert.deepEqual(realImport.set.lanes.map((lane) => lane.stemKey), canonical)
  assert.equal(realImport.set.lanes.at(-1).path, real.outputs.find((output) => output.label === 'ee').path)
  assert.equal(realImport.skipped.length, 5)
  console.log(`PASS seven canonical lanes from ${useReal ? 'real manifest (read only)' : 'real manifest snapshot'} with temporary WAVs`)

  await call('aurora_get_stem_view', { assetId: asset.id })
  const opSet = await call('aurora_create_stem_set', { assetId: asset.id, name: 'Tool custom',
    lanes: [{ stemKey: 'piano', path: customFiles[1] }] })
  assert.equal(opSet.set.lanes[0].label, 'Piano')
  await call('aurora_delete_stem_set', { setId: opSet.set.id }, 'CONFIRMATION_REQUIRED')
  assert.ok(listStoredSets(asset.id).some((set) => set.id === opSet.set.id))
  await call('aurora_delete_stem_set', { setId: opSet.set.id, confirm: true })
  assert.ok(existsSync(customFiles[1]))
  assert.equal((await call('aurora_import_split_job', { jobJsonPath: copiedJob, assetId: asset.id })).reused, true)
  const sets = getStemView(asset.id).sets
  assert.deepEqual(sets.slice(0, 2).map((set) => set.kind), ['split', 'extraction'])
  assert.deepEqual(sets.slice(2).map((set) => set.key), listStoredSets(asset.id).map((set) => `set:${set.id}`))
  deleteStemSet(custom.id)
  assert.ok(customFiles.every(existsSync))
  console.log('PASS operation output schemas, confirmation, set ordering and row-only deletion')

  const moveAudio = await wav(join(scratch, 'move-input.wav'))
  const moving = insertAsset({ projectId: project.id, kind: 'track', name: 'Move fixture', path: moveAudio })
  const stemsDir = getAssetStemsDir(moving)
  const extractsDir = getAssetExtractsDir(moving)
  const ownStem = await wav(join(stemsDir, 'vocals.wav'))
  const ownExtract = await wav(join(extractsDir, 'piano.wav'))
  const nested = await wav(join(stemsDir, 'custom', 'nested.wav'))
  const external = await wav(join(scratch, 'bridge', 'untouched.wav'))
  const sibling = await wav(join(`${stemsDir}-sibling`, 'untouched.wav'))
  db.prepare(`INSERT INTO project_stems (id, project_id, asset_id, stem_type, path, origin)
    VALUES (?, ?, ?, 'vocals', ?, 'imported')`).run(randomUUID(), project.id, moving.id, ownStem)
  db.prepare(`INSERT INTO extraction_stems (id, project_id, asset_id, stem_id, path, created_at)
    VALUES (?, ?, ?, 'piano', ?, ?)`).run(randomUUID(), project.id, moving.id, ownExtract, Date.now())
  createStemSet({ ...setParams, assetId: moving.id, lanes: [
    { stemKey: 'original', label: 'Audio', path: moveAudio }, { stemKey: 'vocals', label: 'Vocals', path: ownStem },
    { stemKey: 'piano', label: 'Piano', path: ownExtract }, { stemKey: 'custom', label: 'Nested', path: nested },
    { stemKey: 'external', label: 'Bridge', path: external }, { stemKey: 'sibling', label: 'Sibling', path: sibling }
  ] })
  const track = await createTrack(project.id, 'Destination')
  const foreignOnly = await wav(join(stemsDir, 'foreign-only.wav'))
  const foreignSet = createStemSet({ ...setParams, name: 'References another asset', sourcePath: moveAudio, lanes: [
    { stemKey: 'original', label: 'Audio B', path: moveAudio },
    { stemKey: 'vocals', label: 'Stem B', path: ownStem },
    { stemKey: 'piano', label: 'Extract B', path: ownExtract },
    { stemKey: 'foreign', label: 'Only referenced by A', path: foreignOnly }
  ] })
  const unregisteredStem = await wav(join(stemsDir, 'unregistered', 'keep.wav'))
  const moved = await setAssetTrack(moving.id, track.id)
  const movedView = getStemView(moving.id)
  const movedLanes = movedView.sets.find((set) => set.kind === 'custom').lanes
  assert.ok(movedLanes.every((lane) => lane.available))
  assert.equal(movedLanes.find((lane) => lane.stemKey === 'original').path, moved.path)
  assert.equal(movedLanes.find((lane) => lane.stemKey === 'vocals').path, join(getAssetStemsDir(moved), 'vocals.wav'))
  assert.equal(movedLanes.find((lane) => lane.stemKey === 'piano').path, join(getAssetExtractsDir(moved), 'piano.wav'))
  assert.equal(movedLanes.find((lane) => lane.stemKey === 'custom').path, join(getAssetStemsDir(moved), 'custom', 'nested.wav'))
  assert.equal(movedLanes.find((lane) => lane.stemKey === 'external').path, external)
  assert.equal(movedLanes.find((lane) => lane.stemKey === 'sibling').path, sibling)
  const foreignMoved = listStoredSets(asset.id).find((set) => set.id === foreignSet.id)
  assert.equal(foreignMoved.sourcePath, moved.path)
  assert.deepEqual(foreignMoved.lanes.map((lane) => lane.path), [moved.path,
    join(getAssetStemsDir(moved), 'vocals.wav'), join(getAssetExtractsDir(moved), 'piano.wav'),
    join(getAssetStemsDir(moved), 'foreign-only.wav')])
  assert.ok(foreignMoved.lanes.every((lane) => existsSync(lane.path)))
  assert.ok(existsSync(unregisteredStem), 'Unknown files in a stem folder must survive an asset move')
  console.log('PASS asset move follows audio/stem/extract files, preserves nested lanes and external paths')
  console.log('PASS lanes and source paths owned by A follow audio, stems and extracts moved with B')

  const deletedTrack = await createTrack(project.id, 'Track with bridge files')
  const oldTrackDir = getTrackDirectory(deletedTrack.id)
  const trackAudio = await wav(join(oldTrackDir, 'tracks', 'input.wav'))
  const trackAsset = insertAsset({ projectId: project.id, trackId: deletedTrack.id,
    kind: 'track', name: 'Bridge source', path: trackAudio })
  const bridge = await manifest('inside-track', canonical, trackAudio, 'done', join(oldTrackDir, 'splits', 'job-1'))
  const originalJob = await readFile(bridge.path)
  const trackImport = await importSplitJob({ jobJsonPath: bridge.path, assetId: trackAsset.id })
  const treeReference = createStemSet({ ...setParams, name: 'Track tree from another asset', sourcePath: oldTrackDir,
    lanes: [{ stemKey: 'vocals', label: 'Bridge vocal', path: trackImport.set.lanes[0].path }] })
  const handFile = join(oldTrackDir, 'notes', 'hand-placed.txt')
  await mkdir(dirname(handFile), { recursive: true })
  await writeFile(handFile, 'Keep this file exactly')
  const unknownStem = await wav(join(getAssetStemsDir(trackAsset), 'unregistered', 'keep.wav'))
  const base = join(getProjectDirectory(project.id), `${deletedTrack.dirName}-files`)
  await mkdir(base)
  await writeFile(join(base, 'sentinel.txt'), 'Existing backup')
  await mkdir(`${base}-2`)
  await deleteTrack(deletedTrack.id)
  const destination = `${base}-3`
  assert.equal(getTrack(deletedTrack.id), null)
  assert.equal(existsSync(oldTrackDir), false)
  assert.equal(await readFile(join(destination, 'notes', 'hand-placed.txt'), 'utf8'), 'Keep this file exactly')
  assert.equal(await readFile(join(base, 'sentinel.txt'), 'utf8'), 'Existing backup')
  assert.ok(existsSync(join(destination, relative(oldTrackDir, unknownStem))))
  const preservedImport = listStoredSets(trackAsset.id).find((set) => set.id === trackImport.set.id)
  assert.equal(preservedImport.sourcePath, join(destination, 'splits', 'job-1', 'job.json'))
  assert.deepEqual(await readFile(preservedImport.sourcePath), originalJob)
  assert.deepEqual(preservedImport.lanes.map((lane) => lane.path),
    trackImport.set.lanes.map((lane) => join(destination, relative(oldTrackDir, lane.path))))
  assert.ok(preservedImport.lanes.every((lane) => existsSync(lane.path)))
  const preservedTree = listStoredSets(asset.id).find((set) => set.id === treeReference.id)
  assert.equal(preservedTree.sourcePath, destination)
  assert.equal(preservedTree.lanes[0].path, preservedImport.lanes[0].path)
  console.log('PASS track deletion preserves bridge tree and hand files, rewrites lanes/source, avoids collisions and removes old folder')

  const referenced = listStoredSets(asset.id).flatMap((set) => set.lanes.map((lane) => lane.path))
  await deleteAsset(asset.id)
  assert.deepEqual(listStoredSets(asset.id), [])
  assert.ok(referenced.every(existsSync), 'Deleting sets with the asset must retain their referenced external files')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stem_lanes WHERE set_id NOT IN (SELECT id FROM stem_sets)').get().n, 0)
  assert.equal(networkAttempts, 0)
  console.log('PASS asset deletion removes stored sets and lanes without deleting referenced files; no network calls')
} finally {
  closeDb()
  globalThis.fetch = originalFetch
  if (previousUserData === undefined) delete process.env.AURORA_USER_DATA
  else process.env.AURORA_USER_DATA = previousUserData
  const withinTemp = relative(resolve(tmpdir()), resolve(scratch))
  assert.ok(withinTemp && withinTemp !== '..' && !withinTemp.startsWith(`..${sep}`) && !withinTemp.startsWith(sep))
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
