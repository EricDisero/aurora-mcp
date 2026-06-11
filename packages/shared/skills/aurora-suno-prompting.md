---
name: aurora-suno-prompting
description: Prompting guide for Aurora's Suno-backed generation ops — generate (ultra-custom full tracks), cover (style transforms + single-layer covers), add_vocals/add_instrumental (layering over existing audio), and sounds (samples/loops with key+tempo lock). Use when writing prompts for aurora_generate, aurora_cover, aurora_add_vocals, aurora_add_instrumental, or aurora_sounds.
---

# Suno Prompting for Aurora

Full wire-param reference: `docs/suno-param-surface.md` in this repo. Research receipts behind the layering recipes: second-brain `business/projects/aurora-docs/suno-layering-playbook-2026-06.md`.

## The one principle that prevents the classic failure

**Only show Suno the material you want performed.** Covers and audio-conditioned ops re-render EVERYTHING in the reference. Feed a full mix and ask for "solo choir" and you get a choir performing the drums. Feed one stem and you get that line re-performed.

## aurora_generate — full tracks (ultra-custom is the default posture)

- **Custom mode** (`customMode: true`, style + title required): `prompt` is the EXACT lyrics, sung as written (≤5000 chars on V4_5+). Use section metatags to steer arrangement: `[Verse]`, `[Chorus]`, `[Choir]`, `[Harmony]`, `[Guitar Solo]`, `[Instrumental]`. This is the default posture — the agent surface exists for full control.
- **Description mode** (`customMode: false`): `prompt` ≤500 chars describing the track; Suno writes its own lyrics. Use only when the user genuinely wants a surprise.
- Knobs: `styleWeight` (style adherence), `weirdnessConstraint` (low = predictable, high = surprises), `negativeTags` (ONE comma-separated string — more reliable than "no X" inside the style text), `vocalGender`, `personaId`/`personaModel` (consistent vocal character across generations; carries timbre, never melodies).
- Models: V5/V5_5 have the best prompt + negative-tag adherence on record. V4 caps style at 200 chars and lyrics at 3000.

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

Models: V4_5PLUS (default) / V5 / V5_5 only.

## aurora_add_instrumental — backing built around an upload

Inverse of add_vocals (input usually a vocal or melodic stem; output full mix with new instrumentation). Field name is `tags`, not `style`. Same split-and-keep-the-new-layer closer.

## aurora_sounds — samples, loops, textures

The layer-manufacturing tool. Prompts are short (max 500 chars), physical, and concrete:

- Name the sound type: braam, boom, riser, downer, whoosh, impact, drone, texture, loop.
- Describe the material: "dark low brass", "metallic scrape", "sub-heavy 808", "airy granular pad".
- Lock `soundKey` (e.g. "Cm", "F#") and `tempo` (BPM) when the destination track is known — this is the point of the tool. Sharps only at the wire (no flats).
- `loop: true` for loopable textures/grooves; `grabLyrics: true` to capture lyric subtitles when the sound has voices.

## When Suno is the wrong tool — say so

For "a choir/vocalist singing the EXACT lines the user wrote, in tune with their track," no Suno path is note-precise. Recommend MIDI-native singing synths (Synthesizer V choir collections, ACE Studio choir mode) or sample libraries, and keep Suno for texture, surprise, and layer-covers where exact notes don't matter. The hybrid worth offering: write the line as MIDI, render it with anything, and aurora_cover THAT render with choir tags.

Each generation-family call returns 2 variations — audition both before generating more.
