---
name: aurora-split-and-stems
description: How Aurora's checked 7-stem split works (3 measured MVSEP routes + phase cancellation), progressive landing, cost rules and files. Use when calling aurora_split or working with split stems; load aurora-separation-routes to choose group extraction instead.
---

# Aurora Split & Stems

## The 7 stems

`vocals, kick, snare, toms, hats, bass, other` (Other). Only 5 come from MVSEP; **hats** and **other** are synthesized locally by phase cancellation (hats = drums − kick − snare − toms; Other = the track minus every stem pulled out in that split). The split's `hats` is the remaining drum bus, including cymbals and residual; use extraction's `drum_hihats` for the dedicated hi-hat output. Other lands last.

For one group, use `aurora_extract` instead: `drums_full` for unpitched drums/orchestral percussion, `choir`, `vocals_all`, `brass`, `woodwind`, `strings`, `keys`, `guitar`, or `percussion` when pitched percussion is wanted too. A family hub is its group model in one job. Load `aurora-separation-routes` and call `aurora_list_separation_routes` for grades, evidence and granularity limits. Stop at the strings/brass group on dense orchestral material.

## How a split runs

3 parallel MVSEP jobs on one standardized 44.1kHz float32 WAV. The measured routes are BS Roformer vocals (`sep_type=40`, `add_opt1=171`), DrumSep (`37`, `add_opt1=7`, `add_opt2=0`), and MVSep Bass (`41`, `add_opt1=5`, `add_opt2=0`). Stems land **progressively** after each job passes its checks:

- vocals job → `vocals`
- drums job → `kick`, `snare`, `toms`, `hats`
- bass job → `bass`
- all three done → `other`

With `background: true`, `aurora_get_job_status` shows the per-job landing state — the user can start auditioning early stems while the rest cook. Typical total: 3-5 minutes (longer if the MVSEP queue is busy — free-tier keys run 1 concurrent job, so the 3 jobs may serialize).

## Check before keeping

Each job has a unique upload name. Aurora verifies the returned algorithm, exact output keys and labels, then checks audio sums and the route's family characteristics before saving. A failed check removes temporary downloads and saves nothing from that job; already checked stems from other jobs may have landed. Read the cause in the error before retrying, because another submission spends again.

`aurora_check_separation_result` checks local files without another provider job. A pass still requires auditioning: brass, strings, keys and guitar have no cheap test for a clean audio-content label swap. See `aurora-separation-routes` for which checks and limits apply.

## Cost rules

- Three paid jobs. MVSEP charges `max(1, floor(seconds × coefficient / 60))` premium minutes per job. At coefficient 1, 15 seconds costs the same one minute as 60 seconds. Check `aurora_get_credits` (mvsepPremiumMinutes) first.
- **Never re-split**: the op returns existing stems instead of spending again when a full set exists.
- For extraction, call `aurora_extract` with `estimateOnly: true` before authorizing the plan; groups and bundles each count once.
- Any asset kind splits: generations, covers, imports, AND references (split-a-reference is a first-class loop for studying an arrangement).

## Read and register stem sets

`aurora_get_stem_view({assetId})` is a free local read of separate Split, Extraction, imported and custom sets. Each lane reports its label, drum group, order and whether the file exists now. Split and Extraction come from their existing stem tables; extraction shows the latest result per stem id. Choose one set at a time: sets can contain overlapping audio.

Use `aurora_import_split_job({jobJsonPath, assetId?, name?})` to register a completed bridge `split` job.json without copying files or spending. It matches the manifest input to an asset when assetId is omitted. Only the seven canonical stems become lanes. Legacy `ee` is the real Other leftover and takes precedence over the overlapping non-bass `other` intermediate. Original, instrumental, crash and ride are skipped with reasons (hats already includes cymbals). Reimporting the same job returns its existing set.

Use `aurora_create_stem_set({assetId, name, lanes:[{stemKey, label?, path}]})` for a hand-made set. Paths must be absolute and exist; stem keys must be unique. Labels default to the split or extraction label, then the stem key. Lanes retain input order with Other shown last. `aurora_delete_stem_set({setId, confirm:true})` removes only stored set and lane rows, never referenced files. Get the UUID from the view's `set:<id>` key. These tools are free and local.

## On disk

Stems live at `<project>/stems/<asset-slug>-<id6>/*.wav` — 32-bit float, sample-aligned by construction. They are DAW-ready files: pitch them (`aurora_pitch_shift`), rip MIDI from them (`aurora_rip_midi`), drag them into the DAW, or point the user at the folder.

Mastering against a reference (analyze → mix → export) happens in the Aurora app window from any split set — not agent-drivable yet.
