---
name: aurora-music-production
description: End-to-end Aurora workflow — create a project, generate or cover tracks, manufacture sounds, split into 7 stems or extract measured instrument groups, organize and hand off to the DAW. Use when driving Aurora (the AI audio workbench) for any music production task.
---

# Aurora Music Production Workflow

Aurora is the desktop layer between AI music generation and a real DAW: generate AI music, split anything into stems, keep it all organized. Files on disk ARE the product — everything you create lands in a real project folder the user can open, play, and drag into their DAW.

## Session start

1. `aurora_get_workspace_state` — projects list, key status, folder locations. Once per session.
2. `aurora_get_credits` — Suno credits + MVSEP minutes. ALWAYS before paid calls (see aurora-cost-discipline).

## The verbs

- **Generate** (`aurora_generate`) — full track from a prompt. 2 variations land as assets. 1-3 min.
- **Cover** (`aurora_cover`) — style-transform an existing asset or file: same musical content, new style. `audioWeight` is the dial: 0 = new style dominates, 1 = stay close to the source.
- **Sounds** (`aurora_sounds`) — samples, one-shots, loops with key/tempo requests. Short clips (~2s one-shots, ~2-13s loops), cheap (~2.5 credits). The sample-manufacturing tool: drum hits, instrument loops, braams, textures. Assembling/mixing them is DAW work — Aurora makes samples, it is not a DAW.
- **Split** (`aurora_split`) — ANY asset → 7 stems (vocals, kick, snare, toms, hats, bass, Other), using BS Roformer vocals 40/171, DrumSep 37/7 and bass 41/5. Results are checked before saving. Three paid MVSEP jobs; never re-split (the op refuses if 7 stems exist).
- **Extract** (`aurora_extract`) — choose the needed group: `drums_full`, `percussion`, `vocals_all`, `choir`, `brass`, `woodwind`, `strings`, `keys`, `guitar`, or catalog instruments/bundles. Each family hub is one group-model job. Load `aurora-separation-routes`, read `aurora_list_separation_routes`, and use `estimateOnly: true` before authorizing spend. Use `drums_full` for unpitched orchestral percussion; stop at the strings/brass group on orchestral material.

## Long-op discipline

Generation and splits take minutes. Prefer `background: true` + `aurora_get_job_status` polling every 10-20s:

- Status responses include `streamUrls` while a generation is still cooking — give the user the link, they can LISTEN ~30-45s in, minutes before files land.
- Split stems land PROGRESSIVELY: vocals/kick/snare/toms/hats/bass appear after each MVSEP job passes its checks; Other (`other`) lands last.
- Jobs survive restarts — `aurora_list_jobs` recovers anything in flight.

Failed identity or audio checks save nothing from the failed job and report the cause; earlier successful jobs may have landed. Read the reason before another paid submission. `aurora_check_separation_result` checks local files without spending. Audition keepers: a clean audio-content label swap in brass, strings, keys or guitar is not detectable. Grades, measured bleed and check limits live in `aurora-separation-routes`.

## Files + organization

- Project folder: `generations/ covers/ imports/ references/ stems/<asset>/ masters/`.
- MP3 lands first; `aurora_fetch_wav` upgrades a generation/cover to provider WAV (~0.4 credits).
- `aurora_pitch_shift` and `aurora_convert` are FREE local ffmpeg ops.
- Mastering (analyze → mix → export) lives in the Aurora app window — point the user there once stems exist; it is not agent-drivable yet.

## Suno prompting quick rules

- Custom mode = set `style` AND `title` together; then `prompt` carries the LYRICS.
- Non-custom mode: `prompt` is a track description.
- `negativeTags` is ONE comma-separated string ("Heavy Metal, Upbeat Drums").
- Sounds prompts: concrete and physical ("huge cinematic braam, dark low brass, trailer hit"), max 500 chars, set `soundKey`/`tempo` when the track they'll sit in is known (requests, not guarantees — verify keepers).
