---
name: aurora-suno-prompting
description: Prompting guide for Aurora's Suno-backed generation ops — generate (ultra-custom full tracks), cover (style transforms + single-layer covers), add_vocals/add_instrumental (layering over existing audio), extend / replace_section / mashup (the v6 editing ops), and sounds (samples/loops with key+tempo lock). Use when writing prompts for aurora_generate, aurora_cover, aurora_add_vocals, aurora_add_instrumental, aurora_extend, aurora_replace_section, aurora_mashup, or aurora_sounds.
---

# Suno Prompting for Aurora

Full wire-param reference: `docs/suno-param-surface.md` in this repo. Research receipts behind the layering recipes: second-brain `business/projects/aurora-docs/suno-layering-playbook-2026-06.md`.

## The one principle that prevents the classic failure

**Only show Suno the material you want performed.** Covers and audio-conditioned ops re-render EVERYTHING in the reference. Feed a full mix and ask for "solo choir" and you get a choir performing the drums. Feed one stem and you get that line re-performed.

## aurora_generate — full tracks (ultra-custom is the default posture)

- **Custom mode** (`customMode: true`, style + title required): `prompt` is the EXACT lyrics, sung as written (≤5000 chars on every model but V4). Use section metatags to steer arrangement: `[Verse]`, `[Chorus]`, `[Choir]`, `[Harmony]`, `[Guitar Solo]`, `[Instrumental]`. This is the default posture — the agent surface exists for full control.
- **Description mode** (`customMode: false`): `prompt` ≤500 chars describing the track; Suno writes its own lyrics. Use only when the user genuinely wants a surprise.
- Knobs: `styleWeight` (style adherence), `weirdnessConstraint` (low = predictable, high = surprises), `negativeTags` (ONE comma-separated string — more reliable than "no X" inside the style text), `vocalGender`, `personaId`/`personaModel` (consistent vocal character across generations; carries timbre, never melodies).
- Models (Suno v6, 2026-09-09): `V6` is the default everywhere; `V6_WILD` trades predictability for range; `V6_MINI` is the fast draft model. `V5_5` and older are deprecated at the provider but still accepted — the only receipt-grade V5_5-vs-V5 A/B on record (UEBS Track 2, 2026-08-14) predates v6, so treat v6 as un-benchmarked and A/B `V6` against `V6_WILD` on a cue before locking a recipe. Hard cap difference: V4 is 200-char style / 3000-char lyrics; everything else 1000 / 5000.
- `duration` (10-360 s) is honoured only in custom mode on V5_5 / V6 / V6_WILD / V6_MINI; the ops refuse it elsewhere rather than let the provider ignore it.

### Isolated / solo material from scratch (a cappella choir, solo instrument)

Pure isolation is a coin flip on every model — stack the odds, expect 2-4 takes, and budget an aurora_split pass on keepers:

1. Style field = ALL voice/instrument descriptors: `epic cinematic choir, a cappella, sacred choral, massed voices, no instruments` (under 200 chars, max 2-3 "no X" exclusions).
2. `negativeTags: "drums, percussion, orchestra, strings, piano, synthesizer, instruments"`.
3. Give the voices a job: Latin or invented syllables in the lyrics with `[Choir]`/`[Harmony]` tags — sung text occupies the slot that otherwise gets filled imitating instruments.
4. Solo instrument: `instrumental: true` (hard mode, reliable) + single-instrument style + negativeTags for everything else.
5. Key/BPM in the style text ("120 BPM, D minor") is approximate guidance, never a lock. For layering-grade sync, condition on audio instead (below) or conform the take in a DAW.

## aurora_cover — style transforms AND single-layer covers

The source's musical content is kept; the style is replaced — for the WHOLE input.

- **Whole-track transform** (same song, new genre): `audioWeight` 0.5-0.7.
- **Single-layer cover** (the layering move — e.g. turn a string melody into a choir line): the reference must be ONLY the line to perform — one stem, a bare MIDI render, even a hummed take. Settings that lock structure while swapping timbre: `audioWeight` 0.7-0.85, `styleWeight` 0.55-0.75, `weirdnessConstraint` 0.2-0.4. Do not upload a dense master and expect surgical obedience. Change one knob at a time between takes.
- Custom mode rules same as generate (style + title together). Source cap 8 minutes (V4_5ALL: 1 minute).

## aurora_add_vocals — vocals/choir over an existing production

The designed-for-layering endpoint: upload an instrumental, get vocals performed against its tempo, key, and changes. THE recipe for "add an epic choir to my finished arrangement":

1. Feed a SIMPLIFIED bounce — harmonic skeleton + the melody the choir should relate to. Strip drums and dense ornamentation first; dense masters degrade conditioning.
2. `style: "epic film choir, massed choral harmonies, latin chant"`, `negativeTags: "lead singer, pop vocal, rap, spoken word, autotune"`, `audioWeight` 0.7-0.85, prompt = Latin/invented syllables with `[Choir]`/`[Harmony]` tags.
3. The output is a full mix. **Discard Suno's backing**: aurora_split the result, keep ONLY the vocals stem, and lay it over the real production. This makes it irrelevant whether the endpoint preserved or re-rendered the upload.

Models: the full enum, default V6 (the pre-v6 V4_5PLUS/V5/V5_5 gate is gone).

## aurora_add_instrumental — backing built around an upload

Inverse of add_vocals (input usually a vocal or melodic stem; output full mix with new instrumentation). Field name is `tags`, not `style`. Same split-and-keep-the-new-layer closer.

## aurora_sounds — one-shots, instrument loops, drum kits, SFX

The sample-manufacturing tool. Suno's officially named categories (verified 2026-06-12): **musical samples & drum kits** ("deep 808 kick drum one shot", "crisp hip hop snare drum", "tight clap sample", "bongo drums pattern loop"), **musical loops** (guitar riffs, basslines, synth licks), **SFX/foley/ambient**. Isolated instrument samples are intended first-party use — but Suno's own docs warn "loops may include full musical arrangements": isolation is not guaranteed, budget retries and an aurora_split pass on keepers. Choir/vocal textures are not a named category — for choir, the generate/add_vocals recipes above stay the lane.

- Prompts ≤500 chars, physical and concrete: instrument + articulation + tone ("palm-muted electric guitar riff, dry, no reverb", "huge cinematic braam, dark low brass").
- **Outputs are SHORT**: one-shots ~2s, loops typically 2-13s (community-measured, Jan 2026; duration is officially undocumented). Never plan around 20-30s clips. Duration may be promptable ("5 second long sound of...") — adherence unverified.
- `soundKey` (Any + C..B + Cm..Bm, sharps only — no flats) and `tempo` (1-300 BPM) are first-party REQUESTS, not locks — no adherence data exists. Verify key/BPM on every keeper before layering (rip_midi/key-detect or DAW).
- `loop: true` = Suno's "seamless repeating clip" mode; seamlessness is a vendor claim — check loop points in the DAW.
- `grabLyrics: true` captures lyric subtitles when the sound has voices.
- Per-element sampling: generate kick/snare/clap one-shots (shared `soundKey`+`tempo` requests), audition, keep the winners. Assembly and mixing are DAW work — Aurora makes the samples, it is not a DAW. Suno sounds vary 2-13s and tempo isn't guaranteed, so they won't be sample-aligned regardless.

## aurora_extend / aurora_replace_section / aurora_mashup — the v6 editing ops

- **Which route fires is decided by the source, not by you.** A Suno-generated asset carries `taskId` + `audioId` in its origin and routes through the id endpoints (no upload → never trips the "matches an existing recording" guard). An imported asset or external file uploads, and Suno rejects its own output there — so to iterate on a Suno take, point the op at the LANDED ASSET, never at a re-exported copy of it.
- **aurora_extend**: `continueAt` is where the new material starts. Set style + title to steer the continuation (custom mode, `continueAt` required); omit both and the provider continues in the source's own settings. The output is the continuation rendered as a full track — trim the overlap in the DAW. Cover already develops past a short seed (32 s in → 1-2 min out), so extend is for "keep THIS take going", not for making a short cover longer.
- **aurora_replace_section**: one window ≥ 10 s; give the window's lyrics in `prompt` AND the whole song's lyrics after the edit in `fullLyrics` (the provider needs both). Everything outside the window is preserved — the surgical fix for one bad bar/phrase instead of a re-roll.
- **aurora_mashup**: exactly two sources, both uploaded. Governing principle still holds — feed the two lines you want combined, not two dense masters.

## Persona — consistent vocal character across generations

Created FROM a completed generation only: the generate-persona endpoint takes `taskId` + `audioId` (no text-only path; optional vocalStart/vocalEnd pick a 10-30s analysis segment). Not an Aurora op yet — create in the Suno web UI or direct API call, then pass the `personaId` to aurora_generate/aurora_cover (custom mode required). `personaModel`: `style_persona` (default) or `voice_persona` (Suno Voice voiceIds; V5_5 and the V6 family). Carries timbre and character, never melodies — not a layering tool.

## What v6 changed for prompting (2026-09-14; external research, no in-house A/B yet)

Receipts: second-brain `business/projects/aurora-docs/suno-v6-prompting-2026-09.md`.

- **Section cues now carry delivery direction.** `[Chorus | massed choir, wordless]` in the lyrics/prompt steers performance per section; v5.5 mostly read the style box. Use it for arrangement and delivery, keep the style field to 4-7 descriptors.
- **Arrangement instructions land more often** (pre-chorus lifts, breakdown placement, instrumental breaks); drums come back cleaner and separable. Obedience on BPM/instrumentation is contested — reports split between "obeys exactly" and "ignores half", and the mixes read cleaner but less characterful. Genre-dependent.
- **Take variance can exceed a prompt edit.** Two variations per call is not an A/B of the prompt. Repeat before concluding.
- **Outputs run longer on Auto** (~3:10 vs ~2:45 on v5.5). Pass `duration` when a layer must fit a cue (custom mode, V6 family).
- **Variety rewrites the style prompt.** In the Suno UI, Variety above Off rewrites your style per generation (default Normal on V6/V6_MINI, Off on V6_WILD). There is NO wire param and the API's inherited state is unknown. First test on any new key: send an identical hand-written style twice on V6 and diff the returned `tags` against what you sent. If they differ, V6_WILD may be the obedient model for locked recipes.
- **Not on the API:** Max Mode (2× credits, consistency over long songs/covers), image/video/playlist references, sampling ("sample the riff at 0:45"). Section edits reach the API only as `replace-section` (a time window + lyrics), not as a sentence.

## Verified vs hypothesis — what this guide can promise

The wire contract above (params, caps, model gates, persona mechanics, official Sounds categories) is receipt-grade from primary docs. **The craft layer is NOT** — adversarial research (2026-06-12) killed or couldn't verify essentially all community prompting lore. Treat as experiments to A/B, not rules:

- Metatag honor rates (structure AND performance tags like `[whispered vocal delivery]`, `[explosive chorus]`) — plausible, zero verified data.
- Lyric formatting as delivery control (line breaks/commas = pacing, parentheticals = backing vocals) — unverified.
- Style-field ordering and length sweet spots; which negativeTags exclusions actually bite — unverified.
- styleWeight/weirdnessConstraint/audioWeight response curves — documented semantics only; the cover ranges in this guide trace to one hands-on test series (strongest available receipt, single source).
- Refuted outright: bracketed length tags (`[3 SECONDS]`) in Sounds prompts; the "describe, characterize, specify" Sounds formula.

Receipts + open questions: second-brain `business/projects/aurora-docs/suno-sounds-and-prompting-2026-06.md`.

## When Suno is the wrong tool — say so

For "a choir/vocalist singing the EXACT lines the user wrote, in tune with their track," no Suno path is note-precise. Recommend MIDI-native singing synths (Synthesizer V choir collections, ACE Studio choir mode) or sample libraries, and keep Suno for texture, surprise, and layer-covers where exact notes don't matter. The hybrid worth offering: write the line as MIDI, render it with anything, and aurora_cover THAT render with choir tags.

Each generation-family call returns 2 variations — audition both before generating more.
