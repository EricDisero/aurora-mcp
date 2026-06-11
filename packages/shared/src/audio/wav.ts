// Minimal RIFF/WAVE reader + writer. No dependency â€” we only need enough to
// decode the WAVs MVSEP returns (PCM 16/24/32-bit int and 32-bit float) into
// planar Float32 channels, do sample-by-sample phase-cancellation, and re-encode
// 32-bit float WAV. Output may exceed Â±1.0 â€” we keep full float headroom and do
// NOT clip or normalize (per mvsep-separation-contract.md Part B).

import { readFile, writeFile } from 'node:fs/promises'

export interface DecodedWav {
  sampleRate: number
  /** Planar: one Float32Array per channel, each `frames` long. */
  channels: Float32Array[]
  frames: number
}

const WAVE_FORMAT_PCM = 0x0001
const WAVE_FORMAT_IEEE_FLOAT = 0x0003
const WAVE_FORMAT_EXTENSIBLE = 0xfffe

export async function decodeWavFile(path: string): Promise<DecodedWav> {
  const buf = await readFile(path)
  return decodeWav(buf)
}

export function decodeWav(buf: Buffer): DecodedWav {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file')
  }

  let fmtFound = false
  let audioFormat = WAVE_FORMAT_PCM
  let numChannels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataLength = 0

  // Walk chunks starting after the 12-byte RIFF header.
  let pos = 12
  while (pos + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', pos, pos + 4)
    const chunkSize = buf.readUInt32LE(pos + 4)
    const bodyStart = pos + 8

    if (chunkId === 'fmt ') {
      audioFormat = buf.readUInt16LE(bodyStart)
      numChannels = buf.readUInt16LE(bodyStart + 2)
      sampleRate = buf.readUInt32LE(bodyStart + 4)
      bitsPerSample = buf.readUInt16LE(bodyStart + 14)
      // WAVE_FORMAT_EXTENSIBLE carries the real format in the subformat GUID's
      // first 2 bytes (cbSize at +16, then valid bits/channel mask, then GUID).
      if (audioFormat === WAVE_FORMAT_EXTENSIBLE && chunkSize >= 26) {
        audioFormat = buf.readUInt16LE(bodyStart + 24)
      }
      fmtFound = true
    } else if (chunkId === 'data') {
      dataOffset = bodyStart
      // Clamp to the actual buffer (some encoders write a bogus 0xFFFFFFFF size).
      dataLength = Math.min(chunkSize, buf.length - bodyStart)
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    pos = bodyStart + chunkSize + (chunkSize % 2)
  }

  if (!fmtFound) throw new Error('WAV missing fmt chunk')
  if (dataOffset < 0) throw new Error('WAV missing data chunk')
  if (numChannels < 1) throw new Error('WAV has no channels')

  const bytesPerSample = bitsPerSample / 8
  const frameSize = bytesPerSample * numChannels
  const frames = Math.floor(dataLength / frameSize)

  const channels: Float32Array[] = Array.from({ length: numChannels }, () => new Float32Array(frames))

  const readSample = makeSampleReader(buf, audioFormat, bitsPerSample)

  for (let f = 0; f < frames; f++) {
    const frameBase = dataOffset + f * frameSize
    for (let ch = 0; ch < numChannels; ch++) {
      channels[ch][f] = readSample(frameBase + ch * bytesPerSample)
    }
  }

  return { sampleRate, channels, frames }
}

function makeSampleReader(
  buf: Buffer,
  audioFormat: number,
  bitsPerSample: number
): (offset: number) => number {
  if (audioFormat === WAVE_FORMAT_IEEE_FLOAT) {
    if (bitsPerSample === 32) return (o) => buf.readFloatLE(o)
    if (bitsPerSample === 64) return (o) => buf.readDoubleLE(o)
    throw new Error(`Unsupported float bit depth: ${bitsPerSample}`)
  }

  if (audioFormat === WAVE_FORMAT_PCM) {
    if (bitsPerSample === 16) return (o) => buf.readInt16LE(o) / 32768
    if (bitsPerSample === 24) {
      return (o) => {
        // 24-bit signed little-endian â†’ sign-extend the high byte.
        const v = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)
        const signed = v & 0x800000 ? v - 0x1000000 : v
        return signed / 8388608
      }
    }
    if (bitsPerSample === 32) return (o) => buf.readInt32LE(o) / 2147483648
    if (bitsPerSample === 8) return (o) => (buf.readUInt8(o) - 128) / 128
    throw new Error(`Unsupported PCM bit depth: ${bitsPerSample}`)
  }

  throw new Error(`Unsupported WAV audio format: 0x${audioFormat.toString(16)}`)
}

/** Encode planar Float32 channels to a 32-bit float WAV buffer. No clipping. */
export function encodeWavFloat32(channels: Float32Array[], sampleRate: number): Buffer {
  const numChannels = channels.length
  if (numChannels === 0) throw new Error('encodeWavFloat32: no channels')
  const frames = channels[0].length
  const bytesPerSample = 4
  const blockAlign = numChannels * bytesPerSample
  const dataLength = frames * blockAlign

  const buf = Buffer.alloc(44 + dataLength)

  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataLength, 4)
  buf.write('WAVE', 8, 'ascii')

  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // PCM-style fmt chunk size
  buf.writeUInt16LE(WAVE_FORMAT_IEEE_FLOAT, 20)
  buf.writeUInt16LE(numChannels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * blockAlign, 28) // byte rate
  buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(32, 34) // bits per sample

  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataLength, 40)

  let offset = 44
  for (let f = 0; f < frames; f++) {
    for (let ch = 0; ch < numChannels; ch++) {
      buf.writeFloatLE(channels[ch][f], offset)
      offset += bytesPerSample
    }
  }

  return buf
}

export async function encodeWavFloat32File(
  path: string,
  channels: Float32Array[],
  sampleRate: number
): Promise<void> {
  await writeFile(path, encodeWavFloat32(channels, sampleRate))
}

/** Element-wise A âˆ’ (B + C + â€¦). All inputs must share frame count + channel
 *  count (true by construction â€” same source, length-preserving models). Output
 *  keeps float headroom; no clipping/normalize. */
export function subtractWavs(minuend: DecodedWav, ...subtrahends: DecodedWav[]): DecodedWav {
  const numChannels = minuend.channels.length
  const frames = minuend.frames

  for (const s of subtrahends) {
    if (s.channels.length !== numChannels) {
      throw new Error(
        `Channel-count mismatch in phase cancellation: ${s.channels.length} vs ${numChannels}`
      )
    }
    if (s.frames !== frames) {
      throw new Error(`Frame-count mismatch in phase cancellation: ${s.frames} vs ${frames}`)
    }
  }

  const out: Float32Array[] = Array.from({ length: numChannels }, (_, ch) => {
    const result = new Float32Array(frames)
    const base = minuend.channels[ch]
    for (let i = 0; i < frames; i++) {
      let v = base[i]
      for (const s of subtrahends) v -= s.channels[ch][i]
      result[i] = v
    }
    return result
  })

  return { sampleRate: minuend.sampleRate, channels: out, frames }
}
