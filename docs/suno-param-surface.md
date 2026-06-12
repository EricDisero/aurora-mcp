# Suno Provider Param Surface (sunoapi.org primary / kie.ai fallback)

Enumerated from live docs.sunoapi.org 2026-06-10 (llms.txt index + per-endpoint pages). This table is THE CONTRACT for `aurora_generate` / `aurora_cover` / `aurora_sounds` / `aurora_add_vocals` / `aurora_add_instrumental` op schemas AND the app's Generate page: no param left unexposed, no param invented. kie.ai mirrors the same `/api/v1/*` shapes.

Rule (locked 2026-06-10): **op schemas expose the full wire surface with sane defaults — curation is the app's job, never the MCP's.**

---

## Shared enums + caps

**Models:** `V4`, `V4_5`, `V4_5PLUS`, `V4_5ALL`, `V5`, `V5_5` (wire ids use underscores; providers normalize dots).
- add-vocals / add-instrumental support `V4_5PLUS` (default), `V5`, `V5_5` only.
- sounds supports `V5` only.

**Char caps:**
| Field | V4 | V4_5 / V4_5PLUS / V5 / V5_5 | V4_5ALL |
|---|---|---|---|
| prompt (custom mode = literal lyrics) | 3000 | 5000 | 5000 |
| prompt (non-custom = description) | 500 | 500 | 500 |
| style | 200 | 1000 | 1000 |
| title | 80 | 100 | 80 |

**The customMode matrix (generate + upload-cover):**
| customMode | instrumental | Required | `prompt` means |
|---|---|---|---|
| true | true | style, title | unused |
| true | false | style, title, prompt | EXACT lyrics, sung as written |
| false | either | prompt only (≤500) | description; lyrics auto-written |

**Shared optional knobs (generate, upload-cover, add-vocals, add-instrumental):**
| Param | Type | Range | Effect |
|---|---|---|---|
| `negativeTags` | string | comma-separated | styles/traits to exclude |
| `vocalGender` | enum | `m` / `f` | vocal preference (wire enum, NOT male/female) |
| `styleWeight` | number | 0.00–1.00 | style guidance intensity |
| `weirdnessConstraint` | number | 0.00–1.00 | creative deviation/novelty |
| `audioWeight` | number | 0.00–1.00 | input-audio influence (audio-conditioned ops) |
| `callBackUrl` | URI | — | required by generate/upload-cover at the wire; Aurora polls instead (placeholder fallback pattern in the clients) |

**Persona (generate + upload-cover, custom mode only):**
| Param | Type | Notes |
|---|---|---|
| `personaId` | string | from Generate Persona endpoint, or a Suno Voice voiceId |
| `personaModel` | enum | `style_persona` (default) / `voice_persona` (use with V5/V5_5 when personaId is a voiceId) |

---

## POST /api/v1/generate (aurora_generate)

Required: `customMode`, `instrumental`, `model`, (`callBackUrl` at the wire). Conditional: `prompt`/`style`/`title` per the matrix. Optional: `negativeTags`, `vocalGender`, `styleWeight`, `weirdnessConstraint`, `audioWeight`, `personaId`, `personaModel`.

Poll: `/api/v1/generate/record-info?taskId=` — statuses PENDING / TEXT_SUCCESS / FIRST_SUCCESS / SUCCESS / *_FAILED / CALLBACK_EXCEPTION / SENSITIVE_WORD_ERROR; `streamAudioUrl` appears mid-task (~30–40s), final URLs 2–3 min; files retained 15 days (download-and-persist immediately). Rate limit 20 req / 10 s.

## POST /api/v1/generate/upload-cover (aurora_cover)

Same surface as generate PLUS `uploadUrl` (required; hosted file from the File Upload API; max 8 min audio, V4_5ALL capped at 1 min). Same matrix, knobs, persona, poll.

## POST /api/v1/generate/sounds (aurora_sounds)

| Param | Type | Required | Default | Range |
|---|---|---|---|---|
| `prompt` | string | yes | — | ≤500 chars |
| `model` | string | yes | — | `V5` only (kie.ai mirror also lists `V5_5` — provider discrepancy, runtime untested) |
| `soundLoop` | boolean | no | false | loopable output |
| `soundTempo` | integer | no | auto | 1–300 BPM |
| `soundKey` | string | no | `Any` | C..B, Cm..Bm (sharps as C#, no flats) |
| `grabLyrics` | boolean | no | — | capture lyric subtitles |
| `callBackUrl` | URI | no | — | optional here |

Semantics (Suno release notes + help center, verified 2026-06-12): one-shots AND loops across three named categories — musical samples & drum kits ("deep 808 kick drum one shot", "crisp hip hop snare", "tight clap", "bongo pattern loop"), musical loops (guitar riffs, basslines, synth licks), SFX/foley/ambient. One-shot drum hits are an official category (earlier "not one-shot drum hits" note here was wrong). Duration officially undocumented; community-measured ~2s one-shots / 2-13s loops (Jan 2026, med confidence). Key/tempo adherence + loop seamlessness unverified — QA every keeper. Receipts: second-brain `business/projects/aurora-docs/suno-sounds-and-prompting-2026-06.md`.

## POST /api/v1/generate/add-vocals (aurora_add_vocals) — NEW op 2026-06-10

Layers AI vocals ON TOP of an uploaded instrumental; the instrumental is preserved under the new vocal content (docs: "preserving the instrumental while adding new vocal content"). THE layering endpoint for the choir-on-existing-arrangement use case.

Required: `uploadUrl`, `prompt` (vocal content/direction), `style`, `title` (≤100), `negativeTags`, (`callBackUrl`). Optional: `vocalGender`, `styleWeight`, `weirdnessConstraint`, `audioWeight`, `model` (V4_5PLUS default / V5 / V5_5).

Callback/poll data carries BOTH `audio_url` (result) and `source_audio_url` (the upload) per variation. Retention 15 days.

## POST /api/v1/generate/add-instrumental (aurora_add_instrumental) — NEW op 2026-06-10

Inverse: generates backing instrumentation complementary to an uploaded audio (usually vocals/stems). Required: `uploadUrl`, `title`, `tags` (NOT `style` — exact field name differs on this endpoint), `negativeTags`, (`callBackUrl`). Optional: `vocalGender`, `styleWeight`, `weirdnessConstraint`, `audioWeight`, `model` (V4_5PLUS default / V5 / V5_5). Retention 14 days.

---

## Wire endpoints documented but NOT exposed as ops (deliberate, revisit on demand)

upload-and-extend / extend-music, replace-section, generate-mashup, cover-suno (style-only cover of a Suno track), generate-persona + boost-music-style, generate-lyrics (+ timestamped lyrics), Suno Voice (custom voices), music video, generate-midi (we rip MIDI locally), separate-vocals (MVSEP path is stronger). Persona PARAMS are exposed on generate/cover; creating personas is not an op yet. generate-persona wire facts (verified 2026-06-12, for when it's promoted): requires `taskId` + `audioId` of a completed generation — no text-only path; optional `vocalStart`/`vocalEnd` select a 10-30s analysis segment; source task must be >v3.5 models; returned `personaId` works on generate / extend / upload-cover / upload-extend (customMode required).
