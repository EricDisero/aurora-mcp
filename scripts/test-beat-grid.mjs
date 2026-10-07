// aurora_beat_grid on a synthetic house loop whose beats are known exactly: 120 BPM, 4/4, first downbeat 0.25 s,
// kick on every beat. Free and offline. Needs the Beat This! environment (python aurora/sidecar-beats/setup_venv.py);
// without it only the missing-engine guidance is checked and the rest is skipped. Build first (npm run build).
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = await mkdtemp(join(tmpdir(), 'aurora-beat-grid-test-'))
const previousUserData = process.env.AURORA_USER_DATA
process.env.AURORA_USER_DATA = scratch
const { ALL_OPERATIONS } = await import('../packages/shared/dist/operations/index.js')
const { closeDb } = await import('../packages/shared/dist/db.js')
const { beatsPythonPath } = await import('../packages/shared/dist/sidecars.js')
const { encodeWavFloat32 } = await import('../packages/shared/dist/audio/wav.js')

const op = ALL_OPERATIONS.find((candidate) => candidate.id === 'aurora_beat_grid')
assert.ok(op, 'aurora_beat_grid is registered')
assert.deepEqual(
  { read: op.annotations.readOnlyHint, destructive: op.annotations.destructiveHint, idempotent: op.annotations.idempotentHint, open: op.annotations.openWorldHint },
  { read: true, destructive: false, idempotent: true, open: false })
assert.ok(op.description.length <= 2048)

const BPM = 120
const FIRST_DOWNBEAT = 0.25
const BARS = 16
const RATE = 44100
const beat = 60 / BPM

/** A four-on-the-floor bar loop: kick every beat, claps on 2 and 4, offbeat hats, a chord stab on each bar's 1. */
function houseLoop() {
  const seconds = FIRST_DOWNBEAT + BARS * 4 * beat + 0.5
  const x = new Float32Array(Math.round(seconds * RATE))
  let seed = 12345
  const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 31 - 1 }
  const put = (start, length, voice) => {
    const first = Math.round(start * RATE)
    for (let i = 0; i < length * RATE && first + i < x.length; i++) x[first + i] += voice(i / RATE)
  }
  // A sine sweeping 150 to 45 Hz (phase = the integral of 45 + 105 e^(-t/0.02) Hz) with a 120 ms decay.
  const kick = (t) => 0.9 * Math.sin(2 * Math.PI * (45 * t + 105 * 0.02 * (1 - Math.exp(-t / 0.02)))) * Math.exp(-t / 0.12)
  const clap = (t) => 0.35 * noise() * Math.exp(-t / 0.05)
  const hat = (t) => 0.18 * noise() * Math.exp(-t / 0.02)
  const stab = (t) => 0.22 * (Math.sin(2 * Math.PI * 261.6 * t) + Math.sin(2 * Math.PI * 329.6 * t) + Math.sin(2 * Math.PI * 392 * t)) * Math.exp(-t / 0.25)
  for (let bar = 0; bar < BARS; bar++) {
    const start = FIRST_DOWNBEAT + bar * 4 * beat
    put(start, 0.4, stab)
    for (let n = 0; n < 4; n++) {
      put(start + n * beat, 0.35, kick)
      if (n % 2 === 1) put(start + n * beat, 0.15, clap)
      put(start + n * beat + beat / 2, 0.05, hat)
    }
  }
  const peak = x.reduce((max, v) => Math.max(max, Math.abs(v)), 0)
  return x.map((v) => (v / peak) * 0.9)
}

try {
  const loop = join(scratch, 'house-120.wav')
  await writeFile(loop, encodeWavFloat32([houseLoop()], RATE))

  // The missing-engine guidance runs everywhere: a typed error that names the one-time setup command.
  const configured = process.env.AURORA_BEATS_PYTHON
  process.env.AURORA_BEATS_PYTHON = join(scratch, 'no-such-venv', 'python.exe')
  const missing = await op.run({ path: loop })
  assert.equal(missing.isError, true)
  assert.equal(missing.structuredContent.error.code, 'ENGINE_NOT_INSTALLED')
  assert.match(missing.structuredContent.error.nextAction, /setup_venv\.py/)
  if (configured === undefined) delete process.env.AURORA_BEATS_PYTHON
  else process.env.AURORA_BEATS_PYTHON = configured
  console.log('PASS missing engine names the setup command')

  const absent = await op.run({ path: join(scratch, 'absent.wav') })
  assert.equal(absent.isError, true)
  assert.equal(absent.structuredContent.error.code, 'NOT_FOUND')
  console.log('PASS missing file is NOT_FOUND')

  if (!existsSync(beatsPythonPath())) {
    console.log(`SKIP engine checks: ${beatsPythonPath()} is missing (run python aurora/sidecar-beats/setup_venv.py)`)
  } else {
    // Missing weights: an analysis never downloads them (only setup_venv.py does); it returns the typed
    // missing-engine error and leaves the empty cache empty.
    const emptyCache = join(scratch, 'empty-torch-cache')
    await mkdir(emptyCache)
    const torchHome = process.env.TORCH_HOME
    process.env.TORCH_HOME = emptyCache
    const noWeights = await op.run({ path: loop })
    if (torchHome === undefined) delete process.env.TORCH_HOME
    else process.env.TORCH_HOME = torchHome
    assert.equal(noWeights.isError, true)
    assert.equal(noWeights.structuredContent.error.code, 'ENGINE_NOT_INSTALLED', JSON.stringify(noWeights.structuredContent))
    assert.match(noWeights.structuredContent.error.nextAction, /setup_venv\.py/)
    assert.deepEqual(await readdir(emptyCache, { recursive: true }), [], 'nothing was downloaded')
    console.log('PASS missing weights: ENGINE_NOT_INSTALLED, no download')

    const first = await op.run({ path: loop, bpmHint: BPM })
    assert.ok(!first.isError, JSON.stringify(first.structuredContent))
    const grid = first.structuredContent
    const near = (actual, expected, tolerance, label) =>
      assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual}, expected ${expected} +/- ${tolerance}`)
    near(grid.bpm, BPM, 0.3, 'bpm')
    assert.equal(grid.meter, 4)
    near(grid.firstDownbeatS, FIRST_DOWNBEAT, 0.04, 'firstDownbeatS')
    assert.ok(grid.beats.length >= BARS * 4 - 2, `beats found: ${grid.beats.length}`)
    assert.ok(grid.downbeats.length >= BARS - 1, `downbeats found: ${grid.downbeats.length}`)
    assert.ok(grid.fit.rmsMs < 12, `fit rms ${grid.fit.rmsMs} ms`)
    assert.equal(grid.hint.relation, 'same')
    assert.equal(grid.kick.reliable, true, JSON.stringify(grid.kick))
    // The synthetic kicks start exactly on the beats, so the offset is the model's own lateness (10 to 30 ms in the bench).
    near(grid.kick.gridMedianOffsetMs, 0, 25, 'kick offset to grid')
    assert.equal(grid.engine.name, 'beat-this')
    assert.equal(grid.source.path, loop)
    console.log(`PASS 120 BPM house loop: ${first.text}`)

    const again = await op.run({ path: loop })
    assert.equal(again.structuredContent.bpm, grid.bpm, 'idempotent')
    assert.equal(again.structuredContent.hint, undefined, 'no hint, no hint report')
    console.log('PASS repeat run gives the same grid')

    // By library asset id: same grid, and the result names the asset.
    const run = async (name, input) => ALL_OPERATIONS.find((candidate) => candidate.id === name).run(input)
    const project = (await run('aurora_create_project', { name: 'Beat grid test' })).structuredContent.project
    const asset = (await run('aurora_import_file', { projectId: project.id, filePath: loop })).structuredContent.asset
    const byAsset = await op.run({ assetId: asset.id })
    assert.ok(!byAsset.isError, JSON.stringify(byAsset.structuredContent))
    assert.equal(byAsset.structuredContent.source.assetId, asset.id)
    assert.equal(byAsset.structuredContent.bpm, grid.bpm)
    console.log('PASS by asset id')
  }
  console.log('Beat grid checks passed.')
} finally {
  closeDb()
  if (previousUserData === undefined) delete process.env.AURORA_USER_DATA
  else process.env.AURORA_USER_DATA = previousUserData
  await rm(scratch, { recursive: true, force: true })
}
