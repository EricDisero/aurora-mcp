import type { DecodedWav } from './wav.js'

type Biquad = { b: [number, number, number]; a: [number, number] }

/** BS.1770 K-weighting, bilinear coefficients at the input rate (De Man).
 * The RLB numerator is intentionally [1,-2,1], without unity-gain scaling. */
export function kWeightingFilters(rate: number): [Biquad, Biquad] {
  if (!Number.isFinite(rate) || rate < 8000) throw new Error('Loudness requires a sample rate of at least 8000 Hz')
  const k = Math.tan(Math.PI * 1681.974450955533 / rate)
  const q = 0.7071752369554196
  const vh = 10 ** (3.999843853973347 / 20)
  const vb = vh ** 0.4996667741545416
  const d = 1 + k / q + k * k
  const shelf: Biquad = {
    b: [(vh + vb * k / q + k * k) / d, 2 * (k * k - vh) / d, (vh - vb * k / q + k * k) / d],
    a: [2 * (k * k - 1) / d, (1 - k / q + k * k) / d]
  }
  const r = Math.tan(Math.PI * 38.13547087602444 / rate)
  const rd = 1 + r / 0.5003270373238773 + r * r
  return [shelf, { b: [1, -2, 1], a: [2 * (r * r - 1) / rd, (1 - r / 0.5003270373238773 + r * r) / rd] }]
}

function filterStep(c: Biquad): (x: number) => number {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  return (x) => {
    const y = c.b[0] * x + c.b[1] * x1 + c.b[2] * x2 - c.a[0] * y1 - c.a[1] * y2
    x2 = x1; x1 = x; y2 = y1; y1 = y
    return y
  }
}

export function amplitudeDb(value: number): number | null {
  return value > 0 ? 20 * Math.log10(value) : null
}

const energyLufs = (energy: number): number => -0.691 + 10 * Math.log10(energy)

// Three fractional phases plus the original samples form a 4x interpolator.
// 64-tap Blackman-windowed sinc per phase; unity DC gain, zero padding at edges.
const RADIUS = 32
const phases = [0.25, 0.5, 0.75].map((fraction) => {
  const taps = Array.from({ length: 2 * RADIUS }, (_, index) => {
    const offset = index - RADIUS + 1
    const x = fraction - offset
    const window = Math.abs(x) >= RADIUS ? 0 :
      0.42 + 0.5 * Math.cos(Math.PI * x / RADIUS) + 0.08 * Math.cos(2 * Math.PI * x / RADIUS)
    return { offset, weight: Math.sin(Math.PI * x) / (Math.PI * x) * window }
  })
  const sum = taps.reduce((total, tap) => total + tap.weight, 0)
  return taps.map((tap) => ({ ...tap, weight: tap.weight / sum }))
})

export function truePeak4x(channels: Float32Array[]): number {
  let peak = 0
  for (const channel of channels) {
    for (const sample of channel) peak = Math.max(peak, Math.abs(sample))
    for (let frame = -RADIUS; frame < channel.length + RADIUS; frame++) {
      for (const phase of phases) {
        let value = 0
        for (const tap of phase) {
          const index = frame + tap.offset
          if (index >= 0 && index < channel.length) value += channel[index] * tap.weight
        }
        peak = Math.max(peak, Math.abs(value))
      }
    }
  }
  return peak
}

/** Mono/stereo BS.1770-4: 400 ms blocks, 100 ms hops, -70 LUFS absolute
 * gate, then -10 LU relative gate. Surround needs channel roles unavailable
 * in DecodedWav, so refuse it rather than accidentally count LFE energy. */
export function measureLoudness(wav: DecodedWav): {
  samplePeakDbfs: number | null; rmsDbfs: number | null; integratedLufs: number | null
  truePeakDbtp: number | null; silent: boolean
} {
  if (wav.channels.length < 1 || wav.channels.length > 2) throw new Error('Loudness requires mono or stereo audio; surround channel roles are unavailable')
  const coefficients = kWeightingFilters(wav.sampleRate)
  const energy = new Float64Array(wav.frames)
  let peak = 0, squares = 0
  for (const channel of wav.channels) {
    if (channel.length !== wav.frames) throw new Error('Audio channels must have the same frame count')
    const shelf = filterStep(coefficients[0]), rlb = filterStep(coefficients[1])
    for (let frame = 0; frame < wav.frames; frame++) {
      const sample = channel[frame]
      if (!Number.isFinite(sample)) throw new Error('Audio must contain finite samples')
      peak = Math.max(peak, Math.abs(sample)); squares += sample * sample
      const weighted = rlb(shelf(sample))
      energy[frame] += weighted * weighted
    }
  }
  const block = Math.round(0.4 * wav.sampleRate), hop = Math.round(0.1 * wav.sampleRate)
  const blocks: number[] = []
  if (wav.frames >= block) {
    let sum = 0
    for (let i = 0; i < block; i++) sum += energy[i]
    blocks.push(sum / block)
    for (let start = hop; start + block <= wav.frames; start += hop) {
      for (let i = start - hop; i < start; i++) sum -= energy[i]
      for (let i = start + block - hop; i < start + block; i++) sum += energy[i]
      blocks.push(Math.max(0, sum / block))
    }
  }
  const absolute = blocks.filter((value) => energyLufs(value) >= -70)
  const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length
  const relativeGate = absolute.length ? energyLufs(mean(absolute)) - 10 : Infinity
  const gated = absolute.filter((value) => energyLufs(value) >= relativeGate)
  return {
    samplePeakDbfs: amplitudeDb(peak),
    rmsDbfs: amplitudeDb(Math.sqrt(squares / (wav.frames * wav.channels.length || 1))),
    integratedLufs: gated.length ? energyLufs(mean(gated)) : null,
    truePeakDbtp: peak ? amplitudeDb(truePeak4x(wav.channels)) : null,
    silent: peak === 0
  }
}
