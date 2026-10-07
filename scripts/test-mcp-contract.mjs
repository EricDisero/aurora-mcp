// Synthetic output identity checked through MCP alone; never submits a provider job.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withIsolatedServer } from './smoke-mcp.mjs'

const sampleRate = 44_100
const seconds = 3

function floatWav(samples) {
  const bytes = Buffer.alloc(44 + samples.length * 4)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(3, 20) // IEEE float
  bytes.writeUInt16LE(1, 22) // mono
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * 4, 28)
  bytes.writeUInt16LE(4, 32)
  bytes.writeUInt16LE(32, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(samples.length * 4, 40)
  samples.forEach((sample, index) => bytes.writeFloatLE(sample, 44 + index * 4))
  return bytes
}

async function writeFixtures(fixtureDir) {
  // Sparse decaying hits have more 10 ms energy variation than a sustained tone.
  // Round each stem to Float32 before summing, as on real WAVs.
  const drums = new Float32Array(sampleRate * seconds)
  const other = new Float32Array(drums.length)
  const input = new Float32Array(drums.length)
  for (let i = 0; i < drums.length; i++) {
    const t = i / sampleRate
    const hitTime = t % 0.25
    drums[i] = 0.45 * Math.exp(-hitTime * 70) * Math.sin(2 * Math.PI * 180 * t)
    other[i] = 0.15 * Math.sin(2 * Math.PI * 440 * t)
    input[i] = drums[i] + other[i]
  }
  await mkdir(fixtureDir, { recursive: true })
  const paths = {}
  for (const [key, samples] of Object.entries({ drums, other, input })) {
    paths[key] = join(fixtureDir, `${key}.wav`)
    await writeFile(paths[key], floatWav(samples))
  }
  return paths
}

async function main() {
  await withIsolatedServer(async (client, tempRoot) => {
    const paths = await writeFixtures(join(tempRoot, 'fixtures'))
    // Discovery lets the SDK validate returned structured content against outputSchema.
    await client.listTools({}, { timeout: 10_000 })
    const failures = []
    for (const test of [
      { name: 'correct drums + complement', outputs: { drums: paths.drums, other: paths.other }, ok: true },
      { name: 'swapped drums + complement', outputs: { drums: paths.other, other: paths.drums }, ok: false, problem: /drums/i },
      { name: 'complement contains the whole input', outputs: { drums: paths.drums, other: paths.input }, ok: false, problem: /add back|sum|holds part/i }
    ]) {
      try {
        const result = await client.callTool({
          name: 'aurora_check_separation_result',
          arguments: { routeId: 'drums_full', inputPath: paths.input, outputs: test.outputs }
        }, undefined, { timeout: 10_000 })
        assert.notEqual(result.isError, true, 'a completed local check returns a verdict, not a tool error')
        assert(result.content.some((item) => item.type === 'text' && item.text.trim()), 'a check needs a text summary')
        const verdict = result.structuredContent
        assert(verdict && typeof verdict === 'object', 'a check needs structuredContent')
        assert.equal(verdict.ok, test.ok, `${test.name}: unexpected verdict`)
        assert(Array.isArray(verdict.problems), 'problems must be an array')
        assert(Array.isArray(verdict.notes), 'notes must be an array')
        assert(verdict.metrics && typeof verdict.metrics === 'object', 'metrics must be an object')
        assert(Object.values(verdict.metrics).every((value) => typeof value === 'number' && Number.isFinite(value)), 'metrics must contain finite numbers')
        assert.equal(verdict.checkWindowSeconds, seconds)
        assert(Array.isArray(verdict.limitations), 'limitations must be an array')
        if (test.ok) {
          assert.deepEqual(verdict.problems, [])
          assert(verdict.metrics.transientMarginDb > 0, 'fixture must be more transient than its complement')
        } else {
          assert(verdict.problems.some((problem) => test.problem.test(problem)), `missing expected problem: ${JSON.stringify(verdict.problems)}`)
        }
        console.log(`PASS ${test.name}`)
      } catch (error) {
        failures.push(`${test.name}: ${error.message}`)
        console.error(`FAIL ${failures.at(-1)}`)
      }
    }
    if (failures.length) throw new AggregateError(failures.map((failure) => new Error(failure)), `${failures.length} separation contract assertions failed`)
    console.log('MCP separation contract passed (44.1 kHz float fixtures; no provider calls).')
  }, { clientName: 'aurora-separation-contract' })
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
