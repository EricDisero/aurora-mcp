---
name: aurora-music-production
description: End-to-end Aurora workflow — create a project, generate or cover tracks, manufacture sounds, split into 7 stems, organize and hand off to the DAW. Use when driving Aurora (the AI audio workbench) for any music production task.
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
- **Split** (`aurora_split`) — ANY asset → 7 stems (vocals, kick, snare, toms, hats, bass, everything-else). REAL MVSEP credits; never re-split (the op refuses if 7 stems exist).

## Long-op discipline

Generation and splits take minutes. Prefer `background: true` + `aurora_get_job_status` polling every 10-20s:

- Status responses include `streamUrls` while a generation is still cooking — give the user the link, they can LISTEN ~30-45s in, minutes before files land.
- Split stems land PROGRESSIVELY: vocals/kick/snare/toms/hats/bass appear as each MVSEP job finishes; everything-else (ee) lands last.
- Jobs survive restarts — `aurora_list_jobs` recovers anything in flight.

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
