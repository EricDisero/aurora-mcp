---
name: aurora-split-and-stems
description: Checked 7-stem splitting, stem sets, offline waveform/loudness measurement and originals/range/mix export. Use when calling aurora_split or measuring/exporting stems without the desktop app; load aurora-separation-routes to choose group extraction.
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

## Measure and export without the desktop app

First call `aurora_get_stem_view({assetId})`, choose one exact `setKey` (`split`, `extraction` or `set:<id>`) and take `laneIds` from its lanes. Omit laneIds to select all lanes. Unknown IDs and missing files fail rather than silently dropping a lane. These tools are free, local and require no running desktop or provider keys.

- `aurora_get_stem_peaks({assetId, setKey, laneIds?, startSeconds?, endSeconds?, points?})` returns native-rate min/max bins of the signed sample with the greatest absolute amplitude across channels, so opposite-phase stereo does not disappear. Default 400 bins, maximum 2000 and 16 lanes per call. Full-file duration and the measured frame range accompany each lane. Empty bins repeat the nearest sample.
- `aurora_measure_stems({assetId, setKey, laneIds?, startSeconds?, endSeconds?})` returns sample peak, mean-channel RMS, BS.1770-4 integrated LUFS and 4x oversampled true peak. K-weighting runs at the file's rate; loudness uses 400 ms blocks with 75% overlap, -70 LUFS absolute and -10 LU relative gates. Mono/stereo only: surround channel roles are unavailable. Digital silence has `silent:true` and null levels. Below-gate or sub-400 ms audio has null LUFS but `silent:false` if nonzero. For a -20 dBFS peak 997 Hz sine, mono is about -23 LUFS, identical stereo about -20 LUFS: channel energies add.
- `aurora_export_stems({assetId, setKey, mode, outDir, laneIds?, gains?, mutes?, solos?, startSeconds?, endSeconds?})` writes audio plus a JSON manifest, returning their paths. outDir must be absolute. Every existing name receives a suffix; nothing is overwritten or registered in the library.

Use `mode:'originals'` for byte-identical whole-file copies. Timing and gain/mute/solo controls are refused for originals. `mode:'range'` trims each lane to a shared start and length in 44.1 kHz float32 WAV; it preserves levels and refuses mix controls. `mode:'mix'` sums audible lanes into one 44.1 kHz float32 WAV: **gain is baked in**, keyed by laneId in dB (default 0). Any solos select the exclusive audible set and override mute; with no solos, all unmuted selected lanes play. All muted renders silence. Controls must name selected lanes.

Range and mix timings round to the nearest 44.1 kHz frame; default start is zero and end is the longest selected lane's duration. Shorter lanes are zero-padded. Channels are retained; mono is duplicated when mixed with stereo, and other channel-count mismatches fail. Measurement/peaks timing must be inside each lane. Read the manifest's actual range, applied gains, per-lane audibility, rate, frames and paths. Originals has per-lane rates and frame counts instead of one shared rate/length. Mix reports sample peak and `clipping:true` above ±1; float headroom is retained. There is no limiter or normalisation. Reduce gain explicitly if desired, then export again.

## On disk

Stems live at `<project>/stems/<asset-slug>-<id6>/*.wav` — 32-bit float, sample-aligned by construction. They are DAW-ready files: pitch them (`aurora_pitch_shift`), rip MIDI from them (`aurora_rip_midi`), drag them into the DAW, or point the user at the folder.

Offline measurement and stem/mix export use the tools above. Reference matching and real-time mastering still use the Aurora app window.
