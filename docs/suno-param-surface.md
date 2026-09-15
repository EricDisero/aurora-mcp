# Suno Provider Param Surface (sunoapi.org primary / kie.ai fallback)

> **Re-verify against live docs before telling anyone a param doesn't exist.** This doc went stale twice: the 2026-06-10 sweep missed `duration` for seven weeks, and the 2026-09-09 Suno v6 launch moved the model enum on every endpoint. Last full sweep: **2026-09-14** (llms.txt index + every per-endpoint page).

This table is THE CONTRACT for the Suno-backed op schemas (`aurora_generate` / `aurora_cover` / `aurora_sounds` / `aurora_add_vocals` / `aurora_add_instrumental` / `aurora_extend` / `aurora_replace_section` / `aurora_mashup`) AND the app's Generate page: no param left unexposed, no param invented. kie.ai mirrors the same `/api/v1/*` shapes.

Rule (locked 2026-06-10): **op schemas expose the full wire surface with sane defaults — curation is the app's job, never the MCP's.**

---

## Shared enums + caps

**Models (Suno v6 launch 2026-09-09; enum verified per endpoint 2026-09-14):** `V6` (default everywhere), `V6_WILD` (more varied / experimental), `V6_MINI` (fast, lightweight). **Deprecated, still on the enum:** `V5_5`, `V5`, `V4_5PLUS`, `V4_5ALL`, `V4_5`, `V4` — sunoapi.org: "backward compatibility only"; kie.ai: "Discontinued". Wire ids use underscores; the clients normalize dots. **The enum + default have one home: `SUNO_MODELS` / `DEFAULT_SUNO_MODEL` / `normalizeModel()` in `providers/suno.ts`.**
- The same enum is accepted on EVERY endpoint: generate, upload-cover, extend, upload-extend, add-vocals, add-instrumental, sounds, mashup, replace-section (upload mode). The pre-v6 gates ("add-vocals/add-instrumental = V4_5PLUS/V5/V5_5 only", "sounds = V5 only") are gone.
- Suno's v6 notes (suno.com/release-notes/introducing-v6): v6 + v6-wild are the paid-tier models, v6-mini the free one; all three add section editing, mashups, sampling, multimodal prompting (text + audio + image + video) and natural-language lyric edits. The API exposes section editing (`replace-section`), mashups (`generate-mashup`) and the extend family. Image/video prompting and NL lyric edits have NO wire endpoint on sunoapi.org as of 2026-09-14.
- Credit cost per v6 generation on sunoapi.org: **unobserved.** Read `aurora_get_credits` before/after the first live call and log it in second-brain `business/operations/api-cost-reference.md`; do not assume the V5_5 12-credit figure carries.

**Char caps:**
| Field | V4 | V4_5 / V4_5PLUS / V5 / V5_5 / V6 / V6_WILD / V6_MINI | V4_5ALL |
|---|---|---|---|
| prompt (custom mode = literal lyrics) | 3000 | 5000 | 5000 |
| prompt (non-custom = description) | 500 | 500 | 500 |
| style | 200 | 1000 | 1000 |
| title | 80 | 100 | 80 |

(kie.ai's page lists title at 80 for every model; sunoapi.org says 100 on V4_5 and later. The ops do not enforce a title cap; the provider does.)

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
| `duration` | integer | 10–360 (sec) | **Target output length. ONLY effective when `customMode: true` AND model ∈ {V5_5, V6, V6_WILD, V6_MINI} — silently ignored otherwise** (kie.ai lists default 20 s). Exposed on generate / cover / mashup since 2026-09-14; the ops throw on a non-honouring model or mode instead of letting the provider ignore it. |

**Persona (generate + upload-cover, custom mode only):**
| Param | Type | Notes |
|---|---|---|
| `personaId` | string | from Generate Persona endpoint, or a Suno Voice voiceId |
| `personaModel` | enum | `style_persona` (default) / `voice_persona` (use with V5_5 or the V6 family when personaId is a voiceId) |

---

## POST /api/v1/generate (aurora_generate)

Required: `customMode`, `instrumental`, `model`, (`callBackUrl` at the wire). Conditional: `prompt`/`style`/`title` per the matrix. Optional: `negativeTags`, `vocalGender`, `styleWeight`, `weirdnessConstraint`, `audioWeight`, `personaId`, `personaModel`.

Poll: `/api/v1/generate/record-info?taskId=` — statuses PENDING / TEXT_SUCCESS / FIRST_SUCCESS / SUCCESS / *_FAILED / CALLBACK_EXCEPTION / SENSITIVE_WORD_ERROR; `streamAudioUrl` appears mid-task (~30–40s), final URLs 2–3 min; files retained 15 days (download-and-persist immediately). Rate limit 20 req / 10 s.

## POST /api/v1/generate/upload-cover (aurora_cover)

Same surface as generate PLUS `uploadUrl` (required; hosted file from the File Upload API; max 8 min audio, V4_5ALL capped at 1 min). Same matrix, knobs, persona, poll.

### ⚠️ You CANNOT upload-cover Suno's own output (verified 2026-07-31)

Uploading audio Suno generated fails with `GENERATE_AUDIO_FAILED` + `errorCode 413`, `errorMessage: "This audio matches an existing recording in our catalog."` This is the endpoint's upload-side copyright/dedup guard — its purpose is blocking covers of catalogued commercial recordings, and Suno's own generations are in that catalog, so a cover-of-a-cover trips it.

**Scope — do not over-read this.** It is a catalog match against Suno's records, NOT a general "is this audio AI-generated" classifier. Passing it implies NOTHING about whether any independent/downstream AI-provenance detector would flag the audio; those are unrelated systems. Do not treat this check as a provenance oracle.

Observed behavior on the guard (one session, n=1 each — not a characterization):
- Raw trim of a Suno cover (48k AND resampled 44.1k, 20s) → matched.
- `varispeed` pitch shift −1st (pure resample, pitch+tempo both move) → still matched.
- `asetrate+atempo` pitch shift −1st (`preserveTempo: true`; resample THEN time-stretch back) → passed.

The discriminator appears to be the time-stretch stage genuinely reconstructing the signal, not the magnitude of pitch/tempo change — varispeed altered more and still matched. **The supported path for iterating on a Suno track is the `taskId`/`audioId` endpoints (`extend`, `replace-section` id-mode), which upload nothing and so never reach this guard.** `aurora_extend` and `aurora_replace_section` route there automatically when the source asset carries provider ids. (`cover-suno` is NOT an audio cover; it generates cover ART. The earlier note here was wrong.)

Length note (n=1): a 20s source produced a 119.8s cover in a style where full-length sources were yielding 64–75s. Source length ≠ output length, and short sources are not inherently penalized.

## POST /api/v1/generate/sounds (aurora_sounds)

| Param | Type | Required | Default | Range |
|---|---|---|---|---|
| `prompt` | string | yes | — | ≤500 chars |
| `model` | string | yes | `V6` | full model enum (the V5-only lock ended with v6; kie.ai does not expose this endpoint at all) |
| `soundLoop` | boolean | no | false | loopable output |
| `soundTempo` | integer | no | auto | 1–300 BPM |
| `soundKey` | string | no | `Any` | C..B, Cm..Bm (sharps as C#, no flats) |
| `grabLyrics` | boolean | no | — | capture lyric subtitles |
| `callBackUrl` | URI | no | — | optional here |

Semantics (Suno release notes + help center, verified 2026-06-12): one-shots AND loops across three named categories — musical samples & drum kits ("deep 808 kick drum one shot", "crisp hip hop snare", "tight clap", "bongo pattern loop"), musical loops (guitar riffs, basslines, synth licks), SFX/foley/ambient. One-shot drum hits are an official category (earlier "not one-shot drum hits" note here was wrong). Duration officially undocumented; community-measured ~2s one-shots / 2-13s loops (Jan 2026, med confidence). Key/tempo adherence + loop seamlessness unverified — QA every keeper. Receipts: second-brain `business/projects/aurora-docs/suno-sounds-and-prompting-2026-06.md`.

## POST /api/v1/generate/add-vocals (aurora_add_vocals) — NEW op 2026-06-10

Layers AI vocals ON TOP of an uploaded instrumental; the instrumental is preserved under the new vocal content (docs: "preserving the instrumental while adding new vocal content"). THE layering endpoint for the choir-on-existing-arrangement use case.

Required: `uploadUrl`, `prompt` (vocal content/direction), `style`, `title` (≤100), `negativeTags`, (`callBackUrl`). Optional: `vocalGender`, `styleWeight`, `weirdnessConstraint`, `audioWeight`, `model` (full enum, default V6).

Callback/poll data carries BOTH `audio_url` (result) and `source_audio_url` (the upload) per variation. Retention 15 days.

## POST /api/v1/generate/add-instrumental (aurora_add_instrumental) — NEW op 2026-06-10

Inverse: generates backing instrumentation complementary to an uploaded audio (usually vocals/stems). Required: `uploadUrl`, `title`, `tags` (NOT `style` — exact field name differs on this endpoint), `negativeTags`, (`callBackUrl`). Optional: `vocalGender`, `styleWeight`, `weirdnessConstraint`, `audioWeight`, `model` (full enum, default V6). Retention 14 days.

---

## POST /api/v1/generate/extend + /api/v1/generate/upload-extend (aurora_extend) — NEW op 2026-09-14

Continue a track from a point in time. One op, two routes, chosen by the source:
- **`extend`** (Suno-generated source): `audioId` (required) + `taskId`; no upload, so the catalog guard never fires.
- **`upload-extend`** (imported / external source): `uploadUrl` (max 8 min); the guard applies, Suno's own output is rejected.

Shared body: `defaultParamFlag` (required; `true` = custom: `style` + `title` required, `continueAt` required, `prompt` = lyrics unless `instrumental`; `false` = the provider reuses the source track's own params), `model` (required, full enum, default V6), `instrumental` (default false), `continueAt` (seconds; upload route: >0 and < source length), plus the shared knobs (`negativeTags`, `vocalGender`, `styleWeight`, `weirdnessConstraint`, `audioWeight`, `personaId`/`personaModel`). Char caps as generate. Poll: `record-info` (`operationType` = `extend` / `upload_extend`, `parentMusicId` = the source). Callback types text / first / complete.

## POST /api/v1/generate/replace-section (aurora_replace_section) — NEW op 2026-09-14

v6 section editing: re-generate one window, keep everything outside it. Required on every call: `prompt` (lyrics for the window), `tags` (style; this endpoint uses `tags`, not `style`), `title`, `infillStartS`, `infillEndS` (seconds, 2 decimals, **window ≥ 10 s**), `fullLyrics` (the whole song's lyrics after the edit). Then ONE of: `taskId` + `audioId` (Suno source; model inherited) OR `uploadUrl` + `model`. Optional `negativeTags`, `callBackUrl`. Poll: `record-info`.

## POST /api/v1/generate/mashup (aurora_mashup) — NEW op 2026-09-14

v6 mashup from **exactly two** uploads: `uploadUrlList` (2 URIs via the File Upload API; the catalog guard applies to both), `customMode`, `model` (full enum, default V6). Optional: `prompt` (5000 custom / 500 non-custom), `style` (≤1000), `title` (**≤80 on this endpoint**), `instrumental`, `vocalGender`, `styleWeight`, `weirdnessConstraint`, `audioWeight`, `duration` (10–360, V6 family, custom mode). Poll: `record-info`.

---

## Wire endpoints documented but NOT exposed as ops (deliberate, revisit on demand)

generate-persona + boost-music-style, generate-lyrics (+ timestamped lyrics), Suno Voice (custom voices), cover-suno (**cover ART**: 2 images per task, one task per source), recovery-audio, music video, generate-midi (we rip MIDI locally), separate-vocals (MVSEP path is stronger). Persona PARAMS are exposed on generate / cover / extend; creating personas is not an op yet. generate-persona wire facts (re-verified 2026-09-14): `POST /api/v1/generate/generate-persona` takes `taskId` + `audioId` + `name` + `description` of a completed generation (no text-only path), optional `vocalStart`/`vocalEnd` (default 0–30; segment must be 10–30 s) and `style`; returns `personaId`, usable on generate / extend / upload-cover / upload-extend (customMode required).
