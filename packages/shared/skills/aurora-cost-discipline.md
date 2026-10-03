---
name: aurora-cost-discipline
description: Credit and spend discipline for every paid Aurora operation (Suno generation/cover/sounds/layering/WAV, MVSEP splits and extractions). Fires before any aurora_generate, aurora_cover, aurora_add_vocals, aurora_add_instrumental, aurora_sounds, aurora_split, aurora_extract, or aurora_fetch_wav call.
---

# Aurora Cost Discipline

Two metered providers sit behind Aurora's cloud ops. Spend is real money. The rules:

## Always

1. **`aurora_get_credits` BEFORE the first paid call of a session** — and after a batch, to log actual spend.
2. **Never re-split.** `aurora_split` burns real MVSEP credits; the op refuses when 7 stems already exist — don't work around it. Check `aurora_list_assets` first. If only a group is needed, load `aurora-separation-routes` and select it through `aurora_extract`; one family hub is one group-model job.
3. **Batch authorization, not per-call nagging.** When the user approves a multi-generation plan ("make me 4 braams and a riser"), that approval covers the enumerated batch — don't re-confirm each call. NEW spend beyond the approved batch needs a fresh ask.

## Known costs (sunoapi.org credits, measured 2026-06-10)

| Op | Cost |
|---|---|
| `aurora_sounds` | ~2.5 credits (~$0.0125) — the cheap verification + layer tool |
| `aurora_cover` | ~12 credits + ~0.4 per WAV fetch |
| `aurora_fetch_wav` | ~0.4 credits per conversion |
| `aurora_generate` | not yet measured — check credits before/after and report the delta |
| `aurora_add_vocals` / `aurora_add_instrumental` | not yet measured — same generation family; check the delta and report it |
| `aurora_split` | MVSEP premium minutes (separate balance); ALWAYS 3 jobs, using measured vocals 40/171, DrumSep 37/7, bass 41/5 routes |
| `aurora_extract` | MVSEP premium minutes, VARIABLE by selection. Call with `estimateOnly: true` before spending; each group is one job, each bundle counts once however many members are selected, and each individual route is one job |
| `aurora_list_separation_routes`, `aurora_check_separation_result` | FREE route listing / local checks; no MVSEP job submitted |
| `aurora_get_credits`, all local ffmpeg/project ops | FREE |

## MVSEP billing and failed checks

MVSEP charges `max(1, floor(seconds × coefficient / 60))` premium minutes per job. Coefficients vary by route. At coefficient 1, a 15-second test and 60 seconds both cost one premium minute; shortening below the floor does not save credits. Aurora's rounded duration estimate and future pack-credit units are not the actual provider debit; report the balance delta after the batch.

Every result is checked before saving. A failed identity or audio check saves nothing from that job and reports the cause; the paid submission has already happened. Read the reason before retrying, use `aurora_check_separation_result` for local checks, and obtain authorization for any submission beyond the approved batch. Do not automatically chain a second separation pass: the measured drums route got worse on a second pass.

## Cheap-first ladder

- Verifying a pipeline or experimenting? `aurora_sounds` first (2.5 credits), full `aurora_generate` only when the user wants a track.
- Audition MP3s before paying for WAV upgrades; `aurora_fetch_wav` only the keepers.
- Local ops (`aurora_pitch_shift`, `aurora_convert`) cost nothing — prefer them over regenerating.
