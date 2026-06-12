---
name: aurora-split-and-stems
description: How Aurora's 7-stem split works (3 MVSEP jobs + phase cancellation), what the stems are, progressive landing, cost rules, and where stems live on disk. Use when calling aurora_split or working with split stems.
---

# Aurora Split & Stems

## The 7 stems

`vocals, kick, snare, toms, hats, bass, ee` (everything-else). Only 5 come from MVSEP; **hats** and **ee** are synthesized locally by phase cancellation (hats = drums − kick − snare − toms; ee = original − vocals − drums − bass). This is why ee always lands LAST.

## How a split runs

3 parallel MVSEP jobs (vocals model, drum separation, bass model) on one standardized 44.1kHz float32 WAV. Stems land **progressively** as each job finishes:

- vocals job → `vocals`
- drums job → `kick`, `snare`, `toms`, `hats`
- bass job → `bass`
- all three done → `ee`

With `background: true`, `aurora_get_job_status` shows the per-job landing state — the user can start auditioning early stems while the rest cook. Typical total: 3-5 minutes (longer if the MVSEP queue is busy — free-tier keys run 1 concurrent job, so the 3 jobs may serialize).

## Cost rules

- REAL MVSEP credits, priced by audio duration. Check `aurora_get_credits` (mvsepPremiumMinutes) first.
- **Never re-split**: the op returns existing stems instead of spending again when a full set exists.
- Any asset kind splits: generations, covers, imports, AND references (split-a-reference is a first-class loop for studying an arrangement).

## On disk

Stems live at `<project>/stems/<asset-slug>-<id6>/*.wav` — 32-bit float, sample-aligned by construction. They are DAW-ready files: pitch them (`aurora_pitch_shift`), rip MIDI from them (`aurora_rip_midi`), drag them into the DAW, or point the user at the folder.

Mastering against a reference (analyze → mix → export) happens in the Aurora app window from any split set — not agent-drivable yet.
