// Offline synthetic audio contracts. Build first; never opens real userData.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

const scratch = await mkdtemp(join(tmpdir(), 'aurora-stem-tools-test-'))
const previousUserData = process.env.AURORA_USER_DATA
process.env.AURORA_USER_DATA = scratch
const originalFetch = globalThis.fetch
let networkAttempts = 0
globalThis.fetch = async () => { networkAttempts++; throw new Error('Stem tools must stay offline') }
const { closeDb, getDb } = await import('../packages/shared/dist/db.js')
const { createProject } = await import('../packages/shared/dist/storage/projects.js')
const { insertAsset } = await import('../packages/shared/dist/storage/assets.js')
const { createStemSet } = await import('../packages/shared/dist/storage/stem-sets.js')
const { getStemView } = await import('../packages/shared/dist/storage/stem-view.js')
const { ALL_OPERATIONS } = await import('../packages/shared/dist/operations/index.js')
const { encodeWavFloat32, decodeWavFile } = await import('../packages/shared/dist/audio/wav.js')
const { measureLoudness, truePeak4x, kWeightingFilters } = await import('../packages/shared/dist/audio/loudness.js')
const { runFfmpeg } = await import('../packages/shared/dist/audio/ffmpeg.js')

const near = (actual, expected, tolerance, label) => {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual}, expected ${expected} +/- ${tolerance}`)
}
function sine(rate, seconds, amplitude = 0.1, frequency = 997, phase = 0) {
  return Float32Array.from({ length: Math.round(rate * seconds) }, (_, frame) =>
    amplitude * Math.sin(2 * Math.PI * frequency * frame / rate + phase))
}
function decoded(channels, rate) { return { channels, sampleRate: rate, frames: channels[0].length } }
async function wav(name, channels, rate = 44100) {
  const path = join(scratch, name)
  await writeFile(path, encodeWavFloat32(channels, rate))
  return path
}
async function call(name, input, errorCode) {
  const op = ALL_OPERATIONS.find((op) => op.id === name)
  assert.ok(op, name)
  const result = await op.run(input)
  const serialized = JSON.parse(JSON.stringify(result.structuredContent))
  assert.ok(op.outputSchema.safeParse(serialized).success, `${name}: outputSchema`)
  if (errorCode) {
    assert.equal(result.isError, true)
    assert.equal(serialized.error.code, errorCode, result.text)
  } else assert.notEqual(result.isError, true, result.text)
  return serialized
}
function sameSamples(actual, expected, label, tolerance = 1e-6) {
  assert.equal(actual.length, expected.length, label)
  for (let frame = 0; frame < actual.length; frame++) near(actual[frame], expected[frame], tolerance, `${label} frame ${frame}`)
}

try {
  // Independent frequency-response expectation from BS.1770's published 48k
  // coefficients: LUFS = -0.691 + 10log10(C * A^2/2 * |H(997)|^2).
  const response = (b, a, frequency, rate) => {
    const w = 2 * Math.PI * frequency / rate
    const power = (c) => {
      const re = c.reduce((sum, value, i) => sum + value * Math.cos(w * i), 0)
      const im = c.reduce((sum, value, i) => sum - value * Math.sin(w * i), 0)
      return re * re + im * im
    }
    return power(b) / power(a)
  }
  const kPower48 = response([1.53512485958697, -2.69169618940638, 1.19839281085285],
    [1, -1.69065929318241, 0.73248077421585], 997, 48000) *
    response([1, -2, 1], [1, -1.99004745483398, 0.99007225036621], 997, 48000)
  const monoExpected = -0.691 + 10 * Math.log10(0.1 ** 2 / 2 * kPower48)
  const stereoExpected = monoExpected + 10 * Math.log10(2)
  for (const rate of [44100, 48000, 96000]) {
    const tone = sine(rate, 1)
    const mono = measureLoudness(decoded([tone], rate))
    const stereo = measureLoudness(decoded([tone, tone], rate))
    near(mono.samplePeakDbfs, -20, 0.002, 'sine sample peak')
    near(mono.rmsDbfs, -23.0102999566, 0.002, 'sine RMS')
    near(mono.integratedLufs, monoExpected, 0.2, `${rate} mono LUFS`)
    near(stereo.integratedLufs, stereoExpected, 0.2, `${rate} stereo LUFS`)
    near(stereo.integratedLufs - mono.integratedLufs, 10 * Math.log10(2), 1e-10, 'channel-energy sum')
    console.log(`LOUDNESS ${rate} Hz 997 Hz sine, -20 dBFS peak: mono=${mono.integratedLufs.toFixed(6)} expected=${monoExpected.toFixed(6)}; stereo=${stereo.integratedLufs.toFixed(6)} expected=${stereoExpected.toFixed(6)}; tolerance=0.2 LU; RMS=${mono.rmsDbfs.toFixed(6)} expected=-23.010300 dBFS`)
  }
  const shelf48 = kWeightingFilters(48000)[0]
  near(shelf48.b[0], 1.53512485958697, 1e-12, '48k shelf reference coefficient')

  // 1k at 8k with pi/8 phase: sample peaks are 1, reconstructed amplitude
  // is sec(pi/8). Fade the edges to isolate the known inter-sample peak.
  const interSample = sine(8000, 1, 1 / Math.cos(Math.PI / 8), 1000, Math.PI / 8)
  for (let frame = 0; frame < interSample.length; frame++) {
    interSample[frame] *= Math.min(1, frame / 400, (interSample.length - 1 - frame) / 400)
  }
  const isp = measureLoudness(decoded([interSample], 8000))
  const ispExpected = 20 * Math.log10(1 / Math.cos(Math.PI / 8))
  near(isp.samplePeakDbfs, 0, 1e-6, '0 dBFS 1k sample peak')
  near(isp.truePeakDbtp, ispExpected, 0.01, '1k inter-sample peak')
  console.log(`TRUE PEAK 1k Hz/8k Hz: sample=${isp.samplePeakDbfs.toFixed(6)} expected=0 dBFS; true=${isp.truePeakDbtp.toFixed(6)} expected=${ispExpected.toFixed(6)} dBTP; tolerance=0.01 dB`)
  assert.ok(truePeak4x([Float32Array.of(1)]) >= 1, 'interpolator never misses original samples')
  const silence = measureLoudness(decoded([new Float32Array(44100), new Float32Array(44100)], 44100))
  assert.deepEqual(silence, { samplePeakDbfs: null, rmsDbfs: null, integratedLufs: null, truePeakDbtp: null, silent: true })
  console.log(`SILENCE ${JSON.stringify(silence)} expected: silent=true, all levels=null`)
  const quiet = measureLoudness(decoded([sine(44100, 1, 0.00001)], 44100))
  assert.equal(quiet.integratedLufs, null, 'absolute -70 LUFS gate')
  assert.equal(quiet.silent, false, 'below-gate audio is not digital silence')
  const short = measureLoudness(decoded([sine(44100, 0.1)], 44100))
  assert.equal(short.integratedLufs, null, 'no full 400 ms block')
  const gatedTone = sine(48000, 4)
  for (let i = 96000; i < gatedTone.length; i++) gatedTone[i] *= 0.001
  const gated = measureLoudness(decoded([gatedTone], 48000))
  const idealBlocks = []
  for (let start = 0; start + 19200 <= gatedTone.length; start += 4800) {
    const loudFraction = Math.max(0, Math.min(19200, 96000 - start)) / 19200
    if (loudFraction >= 0.1) idealBlocks.push(loudFraction)
  }
  const gatedExpected = monoExpected + 10 * Math.log10(idealBlocks.reduce((a, b) => a + b, 0) / idealBlocks.length)
  near(gated.integratedLufs, gatedExpected, 0.05, 'relative gating against analytic block energies')
  console.log(`GATES loud/quiet halves: measured=${gated.integratedLufs.toFixed(6)}, expected=${gatedExpected.toFixed(6)} LUFS; tolerance=0.05 LU`)
  assert.throws(() => measureLoudness(decoded([new Float32Array(10), new Float32Array(10), new Float32Array(10)], 44100)), /mono or stereo/)

  const rate = 44100, frames = rate
  const kick = Float32Array.from({ length: frames }, (_, frame) =>
    frame < 11025 ? 0.7 * Math.exp(-frame / 2205) * Math.sin(2 * Math.PI * 60 * frame / rate) : 0)
  const tone = sine(rate, 1)
  const zero = new Float32Array(frames)
  const kickPath = await wav('kick.wav', [kick])
  const tonePath = await wav('sine.wav', [tone])
  const silentPath = await wav('silent.wav', [zero])
  const project = await createProject('Offline stem tools')
  const asset = insertAsset({ projectId: project.id, kind: 'track', name: 'Synthetic', path: tonePath })
  const stored = createStemSet({ projectId: project.id, assetId: asset.id, kind: 'custom', name: 'Fixture',
    lanes: [{ stemKey: 'kick', label: 'Kick', path: kickPath }, { stemKey: 'sine', label: 'Sine', path: tonePath },
      { stemKey: 'silent', label: 'Silence', path: silentPath }] })
  const setKey = `set:${stored.id}`
  const selection = { assetId: asset.id, setKey }
  const view = getStemView(asset.id)
  const laneIds = view.sets[0].lanes.map((lane) => lane.laneId)
  const [kickId, sineId, silentId] = laneIds
  const peaks = await call('aurora_get_stem_peaks', selection)
  assert.equal(peaks.lanes.length, 3)
  for (const lane of peaks.lanes) {
    assert.equal(lane.peaks.length, 400)
    assert.equal(lane.sampleRate, rate)
    assert.equal(lane.durationSeconds, 1)
    for (let point = 0; point < 400; point++) {
      const source = lane.laneId === kickId ? kick : lane.laneId === sineId ? tone : zero
      const values = source.subarray(Math.floor(point * frames / 400), Math.floor((point + 1) * frames / 400))
      assert.deepEqual(lane.peaks[point], [Math.min(...values), Math.max(...values)])
    }
  }
  const tiny = await call('aurora_get_stem_peaks', { ...selection, laneIds: [sineId], startSeconds: 0.2,
    endSeconds: 0.2 + 1 / rate, points: 2000 })
  assert.equal(tiny.lanes[0].peaks.length, 2000)
  for (const bin of tiny.lanes[0].peaks) assert.deepEqual(bin, [tone[8820], tone[8820]])
  await call('aurora_get_stem_peaks', { ...selection, points: 2001 }, 'INVALID_ARGUMENT')
  await call('aurora_get_stem_peaks', { ...selection, points: 0 }, 'INVALID_ARGUMENT')
  await call('aurora_get_stem_peaks', { ...selection, laneIds: Array(17).fill(sineId) }, 'INVALID_ARGUMENT')
  const many = createStemSet({ projectId: project.id, assetId: asset.id, kind: 'custom', name: '17 lanes',
    lanes: Array.from({ length: 17 }, (_, i) => ({ stemKey: `lane${i}`, label: String(i), path: tonePath })) })
  await call('aurora_get_stem_peaks', { ...selection, setKey: `set:${many.id}` }, 'INVALID_ARGUMENT')
  await call('aurora_measure_stems', { ...selection, laneIds: ['split:kick'] }, 'INVALID_ARGUMENT')
  await call('aurora_measure_stems', { ...selection, laneIds: [sineId, sineId] }, 'INVALID_ARGUMENT')
  await call('aurora_measure_stems', { ...selection, endSeconds: 2 }, 'INVALID_ARGUMENT')
  await call('aurora_measure_stems', { ...selection, startSeconds: 0.5, endSeconds: 0.4 }, 'INVALID_ARGUMENT')
  await call('aurora_measure_stems', { ...selection, startSeconds: 1 }, 'INVALID_ARGUMENT')
  const measured = await call('aurora_measure_stems', selection)
  near(measured.lanes[1].rmsDbfs, -23.0102999566, 0.002, 'operation sine RMS')
  near(measured.lanes[1].integratedLufs, monoExpected, 0.2, 'operation sine LUFS')
  assert.deepEqual(measured.lanes[2], { laneId: silentId, sampleRate: rate, ...silence,
    measuredRange: { startSeconds: 0, endSeconds: 1, startFrame: 0, endFrame: frames, frames } })
  const kickSquares = kick.reduce((sum, sample) => sum + sample * sample, 0)
  near(measured.lanes[0].rmsDbfs, 10 * Math.log10(kickSquares / frames), 1e-10, 'burst analytic RMS')
  const silentTail = await call('aurora_measure_stems', { ...selection, laneIds: [kickId], startSeconds: 0.5, endSeconds: 1 })
  assert.equal(silentTail.lanes[0].silent, true, 'measurement only includes the selected range')
  assert.equal(silentTail.lanes[0].measuredRange.startFrame, 22050)
  console.log('PASS waveform bin extrema, shape, limits, frame rounding, selection/range refusal and analytic stem measurements')

  // Derived set keys are resolved by the same view, including latest extraction.
  getDb().prepare("INSERT INTO project_stems (id, project_id, asset_id, stem_type, path, origin) VALUES (?, ?, ?, 'kick', ?, 'imported')")
    .run(randomUUID(), project.id, asset.id, kickPath)
  getDb().prepare("INSERT INTO extraction_stems (id, project_id, asset_id, stem_id, path, created_at) VALUES (?, ?, ?, 'piano', ?, ?)")
    .run(randomUUID(), project.id, asset.id, tonePath, Date.now())
  assert.equal((await call('aurora_get_stem_peaks', { ...selection, setKey: 'split' })).lanes[0].laneId, 'split:kick')
  assert.equal((await call('aurora_measure_stems', { ...selection, setKey: 'extraction' })).lanes[0].laneId, 'extraction:piano')

  const outDir = join(scratch, 'exports')
  await mkdir(outDir)
  const sentinel = Buffer.from('Never overwrite this file')
  await writeFile(join(outDir, 'mix.wav'), sentinel)
  await writeFile(join(outDir, 'stem-export.json'), sentinel)
  const mix = await call('aurora_export_stems', { ...selection, mode: 'mix', outDir, laneIds: [kickId, sineId] })
  const summed = Float32Array.from(kick, (sample, frame) => sample + tone[frame])
  const rendered = await decodeWavFile(mix.manifest.paths[0])
  sameSamples(rendered.channels[0], summed, 'sample-wise sum')
  assert.equal(rendered.sampleRate, rate)
  assert.equal(mix.manifest.frames, frames)
  assert.deepEqual(JSON.parse(await readFile(mix.manifestPath, 'utf8')), mix.manifest)
  assert.deepEqual(await readFile(join(outDir, 'mix.wav')), sentinel)
  assert.deepEqual(await readFile(join(outDir, 'stem-export.json')), sentinel)
  const solo = await call('aurora_export_stems', { ...selection, mode: 'mix', outDir,
    solos: [sineId], mutes: [sineId], gains: { [sineId]: -6 } })
  const soloWav = await decodeWavFile(solo.manifest.paths[0])
  sameSamples(soloWav.channels[0], Float32Array.from(tone, (v) => v * 10 ** (-6 / 20)), 'solo overrides mute and gain is baked in')
  assert.deepEqual(solo.manifest.lanes.map((lane) => lane.audible), [false, true, false])
  const muted = await call('aurora_export_stems', { ...selection, mode: 'mix', outDir, mutes: laneIds })
  assert.equal(muted.manifest.peak, 0)
  assert.equal(muted.manifest.peakDbfs, null)
  assert.equal(muted.manifest.clipping, false)
  assert.ok((await decodeWavFile(muted.manifest.paths[0])).channels[0].every((v) => v === 0))
  const clipping = await call('aurora_export_stems', { ...selection, mode: 'mix', outDir, laneIds: [sineId], gains: { [sineId]: 30 } })
  assert.equal(clipping.manifest.clipping, true)
  near(clipping.manifest.peak, Math.max(...tone.map((v) => Math.abs(v))) * 10 ** 1.5, 1e-6, 'unlimited clipping peak')
  assert.ok((await decodeWavFile(clipping.manifest.paths[0])).channels[0].some((v) => Math.abs(v) > 1))
  const ranged = await call('aurora_export_stems', { ...selection, mode: 'range', outDir, startSeconds: 0.125, endSeconds: 0.5 })
  const start = Math.round(0.125 * rate), end = rate / 2
  for (const [index, path] of ranged.manifest.paths.entries()) {
    const trimmed = await decodeWavFile(path)
    assert.equal(trimmed.frames, end - start)
    sameSamples(trimmed.channels[0], [kick, tone, zero][index].slice(start, end), 'aligned range')
    assert.equal(ranged.manifest.lanes[index].frames, end - start)
  }
  assert.equal(ranged.manifest.range.startFrame, start)
  const originals = await call('aurora_export_stems', { ...selection, mode: 'originals', outDir })
  for (const lane of originals.manifest.lanes) assert.deepEqual(await readFile(lane.path), await readFile(lane.sourcePath))
  const repeat = await call('aurora_export_stems', { ...selection, mode: 'originals', outDir })
  assert.ok(repeat.manifest.paths.every((path) => !originals.manifest.paths.includes(path)))
  const concurrent = await Promise.all([0, 1].map(() => call('aurora_export_stems', { ...selection, mode: 'mix', outDir })))
  assert.notEqual(concurrent[0].manifest.paths[0], concurrent[1].manifest.paths[0])
  assert.notEqual(concurrent[0].manifestPath, concurrent[1].manifestPath)
  await call('aurora_export_stems', { ...selection, mode: 'mix', outDir: 'relative' }, 'INVALID_ARGUMENT')
  await call('aurora_export_stems', { ...selection, mode: 'mix', outDir, solos: ['bogus'] }, 'INVALID_ARGUMENT')
  await call('aurora_export_stems', { ...selection, mode: 'range', outDir, gains: { [sineId]: 2 } }, 'INVALID_ARGUMENT')
  await call('aurora_export_stems', { ...selection, mode: 'originals', outDir, startSeconds: 0 }, 'INVALID_ARGUMENT')
  console.log('PASS sum, solo/mute/gain, muted silence, unclipped float headroom, aligned range, byte-identical originals, manifest and concurrent no-overwrite')

  // Compressed/native-rate decode, resampling, shorter-lane padding and mono/stereo mixing.
  const antiPhase = sine(48000, 0.5)
  const stereoPath = await wav('stereo48.wav', [antiPhase, Float32Array.from(antiPhase, (v) => -v)], 48000)
  const mp3Path = join(scratch, 'tone.mp3')
  await runFfmpeg(['-nostdin', '-v', 'error', '-i', stereoPath, '-c:a', 'libmp3lame', mp3Path])
  const formats = createStemSet({ projectId: project.id, assetId: asset.id, kind: 'custom', name: 'Formats', lanes: [
    { stemKey: 'stereo', label: 'Stereo48', path: stereoPath }, { stemKey: 'mono', label: 'Mono44', path: tonePath },
    { stemKey: 'mp3', label: 'MP3', path: mp3Path }] })
  const formatSelection = { ...selection, setKey: `set:${formats.id}` }
  const formatIds = getStemView(asset.id).sets.find((set) => set.key === formatSelection.setKey).lanes.map((lane) => lane.laneId)
  const nativePeaks = await call('aurora_get_stem_peaks', { ...formatSelection, laneIds: [formatIds[0]] })
  assert.equal(nativePeaks.lanes[0].sampleRate, 48000)
  assert.ok(nativePeaks.lanes[0].peaks.every(([min, max]) => min < 0 && max > 0), 'anti-phase channels do not cancel peaks')
  const maximumPath = await wav('max-abs.wav', [Float32Array.of(0.25, -0.75), Float32Array.of(-0.5, 0.25)])
  const maximumSet = createStemSet({ projectId: project.id, assetId: asset.id, kind: 'custom', name: 'Max abs',
    lanes: [{ stemKey: 'maximum', label: 'Maximum', path: maximumPath }] })
  const maximumPeaks = await call('aurora_get_stem_peaks', { ...selection, setKey: `set:${maximumSet.id}`, points: 2 })
  assert.deepEqual(maximumPeaks.lanes[0].peaks, [[-0.5, -0.5], [-0.75, -0.75]], 'signed max-abs channel selection')
  const compressed = await call('aurora_measure_stems', { ...formatSelection, laneIds: [formatIds[2]] })
  assert.equal(compressed.lanes[0].sampleRate, 48000)
  assert.equal(compressed.lanes[0].silent, false)
  const compressedOriginal = await call('aurora_export_stems', { ...formatSelection, mode: 'originals', outDir, laneIds: [formatIds[2]] })
  assert.deepEqual(await readFile(compressedOriginal.manifest.paths[0]), await readFile(mp3Path))
  const resampled = await call('aurora_export_stems', { ...formatSelection, laneIds: formatIds.slice(0, 2), mode: 'range', outDir, startSeconds: 0.25, endSeconds: 0.75 })
  const stereoRange = await decodeWavFile(resampled.manifest.paths[0])
  const monoRange = await decodeWavFile(resampled.manifest.paths[1])
  assert.equal(stereoRange.sampleRate, 44100)
  assert.equal(stereoRange.frames, monoRange.frames)
  assert.equal(stereoRange.channels.length, 2)
  assert.ok(stereoRange.channels.every((channel) => channel.slice(11025).every((v) => v === 0)), 'short lane padded with silence')
  const late = await call('aurora_export_stems', { ...formatSelection, laneIds: formatIds.slice(0, 2), mode: 'range', outDir, startSeconds: 0.75 })
  assert.ok((await decodeWavFile(late.manifest.paths[0])).channels.every((channel) => channel.every((v) => v === 0)))
  const stereoMix = await call('aurora_export_stems', { ...formatSelection, laneIds: formatIds.slice(0, 2), mode: 'mix', outDir, startSeconds: 0.25, endSeconds: 0.75 })
  const stereoMixWav = await decodeWavFile(stereoMix.manifest.paths[0])
  for (let channel = 0; channel < 2; channel++) sameSamples(stereoMixWav.channels[channel],
    Float32Array.from(stereoRange.channels[channel], (v, i) => v + monoRange.channels[0][i]), 'mono duplication and resampling sum')
  getDb().prepare('UPDATE stem_lanes SET path = ? WHERE set_id = ? AND stem_key = ?').run(join(scratch, 'missing.wav'), stored.id, 'silent')
  await call('aurora_measure_stems', selection, 'NOT_FOUND')
  assert.equal(networkAttempts, 0)
  console.log('PASS split/extraction/custom resolution, anti-phase/native-rate peaks, MP3 decode, resampling, padding, missing files; zero network attempts')
} finally {
  closeDb()
  globalThis.fetch = originalFetch
  if (previousUserData === undefined) delete process.env.AURORA_USER_DATA
  else process.env.AURORA_USER_DATA = previousUserData
  const withinTemp = relative(resolve(tmpdir()), resolve(scratch))
  assert.ok(withinTemp && withinTemp !== '..' && !withinTemp.startsWith(`..${sep}`) && !withinTemp.startsWith(sep))
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
