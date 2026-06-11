// Musical key detection — Krumhansl-Schmuckler, ported from prism's
// sample_worker.py detect_key (lines 134-215). Pure TS: Hann-windowed STFT
// (radix-2 FFT, n_fft 4096, hop 1024) over the first 60 seconds, chroma
// accumulation across 27.5 Hz–4186 Hz (A0–C8), Pearson correlation against the
// rotated Krumhansl-Kessler major profile. Returns "C major / A minor" form.
//
// LOCKSTEP: identical copy of aurora's src/main/extract/key-detect.ts.

import { decodeWavFile } from './audio/wav.js'

// Krumhansl-Kessler major key profile (1990).
const KRUMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const N_FFT = 4096
const HOP = N_FFT / 4

/** In-place iterative radix-2 complex FFT (re/im of length n, power of 2). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cwr = 1
      let cwi = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]
        const ui = im[i + k]
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const nwr = cwr * wr - cwi * wi
        cwi = cwr * wi + cwi * wr
        cwr = nwr
      }
    }
  }
}

function pearson(a: number[], b: number[]): number {
  const n = a.length
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= n
  mb /= n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma
    const xb = b[i] - mb
    num += xa * xb
    da += xa * xa
    db += xb * xb
  }
  const den = Math.sqrt(da * db)
  return den > 0 ? num / den : 0
}

/** Detect the musical key of an audio file. Returns "C major / A minor" or
 *  null when detection fails (never throws — key is a nice-to-have). */
export async function detectKey(audioPath: string): Promise<string | null> {
  try {
    const wav = await decodeWavFile(audioPath)
    const sr = wav.sampleRate

    // Mono mix of the first 60 seconds.
    const maxSamples = Math.min(60 * sr, wav.channels[0].length)
    const mono = new Float64Array(maxSamples)
    const chCount = wav.channels.length
    for (let i = 0; i < maxSamples; i++) {
      let s = 0
      for (let c = 0; c < chCount; c++) s += wav.channels[c][i]
      mono[i] = s / chCount
    }

    if (maxSamples < N_FFT) return null

    // Hann window.
    const window = new Float64Array(N_FFT)
    for (let i = 0; i < N_FFT; i++) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N_FFT - 1)))

    // Precompute the pitch class per usable bin (27.5 Hz–4186 Hz, A0–C8).
    const binPitchClass = new Int8Array(N_FFT / 2 + 1).fill(-1)
    for (let bin = 0; bin <= N_FFT / 2; bin++) {
      const freq = (bin * sr) / N_FFT
      if (freq < 27.5 || freq > 4186) continue
      const midi = 12 * Math.log2(freq / 440) + 69
      binPitchClass[bin] = ((Math.round(midi) % 12) + 12) % 12
    }

    const chroma = new Float64Array(12)
    const re = new Float64Array(N_FFT)
    const im = new Float64Array(N_FFT)

    for (let start = 0; start + N_FFT <= maxSamples; start += HOP) {
      for (let i = 0; i < N_FFT; i++) {
        re[i] = mono[start + i] * window[i]
        im[i] = 0
      }
      fft(re, im)
      for (let bin = 0; bin <= N_FFT / 2; bin++) {
        const pc = binPitchClass[bin]
        if (pc < 0) continue
        chroma[pc] += Math.hypot(re[bin], im[bin])
      }
    }

    let total = 0
    for (let i = 0; i < 12; i++) total += chroma[i]
    if (total <= 0) return null
    const normalized: number[] = []
    for (let i = 0; i < 12; i++) normalized.push(chroma[i] / total)

    // Correlate against the major profile rotated to each key.
    let bestKey = 0
    let bestCorr = -Infinity
    for (let shift = 0; shift < 12; shift++) {
      const rotated: number[] = []
      for (let i = 0; i < 12; i++) rotated.push(KRUMHANSL_MAJOR[(i - shift + 12) % 12])
      const corr = pearson(normalized, rotated)
      if (corr > bestCorr) {
        bestCorr = corr
        bestKey = shift
      }
    }

    const major = NOTE_NAMES[bestKey]
    const minor = NOTE_NAMES[(bestKey + 9) % 12]
    return `${major} major / ${minor} minor`
  } catch {
    return null
  }
}
