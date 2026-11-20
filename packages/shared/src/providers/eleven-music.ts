import { getElevenLabsKey } from '../config.js'

// The API defaults to the legacy model unless model_id is set explicitly.
export const ELEVEN_MUSIC_MODEL = 'music_v2_5'
export const ELEVEN_MUSIC_FORMAT = 'mp3_48000_192'

type MusicRequest = { prompt: string; durationSeconds: number; instrumental: boolean }

export async function composeMusic(request: MusicRequest, signal?: AbortSignal) {
  const key = getElevenLabsKey()
  if (!key) {
    throw Object.assign(new Error('Eleven Music needs an ElevenLabs API key with Music Generation permission.'), {
      code: 'ELEVEN_MUSIC_KEY_MISSING',
      nextAction: 'Set ELEVENLABS_API_KEY or elevenLabsApiKey in the Aurora key config.'
    })
  }
  const response = await fetch(`https://api.elevenlabs.io/v1/music?output_format=${ELEVEN_MUSIC_FORMAT}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: request.prompt,
      music_length_ms: Math.round(request.durationSeconds * 1000),
      model_id: ELEVEN_MUSIC_MODEL,
      force_instrumental: request.instrumental
    }),
    signal: AbortSignal.any([AbortSignal.timeout(600_000), ...(signal ? [signal] : [])])
  })
  if (!response.ok) {
    const detail = (await response.text()).replaceAll(key, '[redacted]').slice(0, 1500)
    throw Object.assign(new Error(`Eleven Music HTTP ${response.status}: ${detail}`), {
      code: 'ELEVEN_MUSIC_PROVIDER_ERROR',
      httpStatus: response.status,
      retryable: false,
      nextAction: 'Check the provider response before authorizing a new generation.'
    })
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 4 || !(bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) {
    throw new Error('Eleven Music returned no valid MP3 stream.')
  }
  return { bytes, songId: response.headers.get('song-id') }
}
