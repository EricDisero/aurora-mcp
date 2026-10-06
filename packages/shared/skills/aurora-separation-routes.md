---
name: aurora-separation-routes
description: Load when choosing how to split or extract a stem with Aurora, or judging a separation result. Covers measured routes, quality grades, family limits, checks and MVSEP cost.
---

# Aurora Separation Routes

Choose the part and the route before spending. A family hub means its **group model in one job**, not a chain of jobs for each instrument in that family.

## Choose a tool

1. `aurora_list_separation_routes` lists the current routes, exact delivered stem ids, options, quality and evidence. Read it before selecting a route.
2. `aurora_extract` selects groups or instruments using the catalog ids below. Call with `estimateOnly: true` first to see the call plan without spending; check `aurora_get_credits` and obtain authorization for that plan before running it.
3. `aurora_split` makes the fixed seven stems: `vocals`, `kick`, `snare`, `toms`, `hats`, `bass`, `other`. Use extraction when only a group or a few parts are needed.
4. `aurora_check_separation_result` checks files already on disk without submitting another MVSEP job. Read the tool schema for its required input and output files; a delivered stem alone may omit the complement or bus needed for the checks.

Example extraction selection: `stems: ["drums_full", "choir", "brass"]`. Each group is one job. `vocals_all` is also a group stem id; the vocal bundle ids below are selected through `vocalMode` instead.

## Measured choices

Source: the owner's stem map, 2026-10-02, from 50 real splits of 15-second clips mixed from true stems. Numbers are SDR in dB against the true stem, not confidence percentages or promises for a new track. At 20 dB and up a result sounds clean; around 10 is good with audible bleed; 3–5 holds the part with clear bleed; near 0 has as much error as signal.

Grades are the route catalog's `quality`: good, fair, rough, untested. They describe the material tested; a good band route can still struggle under an orchestra.

| Need / extract stem id | Chosen route | Grade | Measured SDR and limits |
|---|---|---|---|
| Drums with nothing pitched; unpitched orchestral percussion: `drums_full` | MVSep Drums 44, `add_opt1=6` | good | 9.2 with pitched residue, 5.5 full orchestra, 24.0 band; 96% percussion, 4% pitched residue. A second pass made it worse: 9.1 / 4.9. |
| Broader percussion including pitched percussion: `percussion` | MVSep Percussion 105 | fair | 7.3 / 4.7 orchestral; below `drums_full` for removing pitched material. For taiko, toms, hits and cymbals together, choose `drums_full`. |
| All vocals: `vocals_all` | BS Roformer 40, `add_opt1=171` | good | 11.4 band, 3.8 choir with orchestra. |
| Choir only: `choir` | MVSep Choir 112, `add_opt2=0` | rough | 3.8 choir with orchestra, 3.3 full orchestra; 93% choir energy with orchestral bleed. Vocals-first and chained routes gave no gain: 3.7 / 3.8. |
| Brass / horns: `brass` | MVSep Brass 107, `add_opt1=0` | rough | 2.1 horn melody with strings and pads, 2.0 full orchestra; 77% brass. Audition on the real take. |
| Woodwinds: `woodwind` | MVSep Woodwind 108, `add_opt1=0` | untested | No woodwinds in the test clips; research rank only. |
| Strings: `strings` | MVSep Bowed Strings 52, `add_opt1=1` | rough | 3.6 with piano, 1.7 full orchestra. |
| All keyboards: `keys` | MVSep Keys 106 | fair | 5.5 with piano and strings. |
| All guitars: `guitar` | MVSep Guitar 31, `add_opt1=7` | fair | 8.1 band. |
| Bass: `bass` | MVSep Bass 41, `add_opt1=5` | good | 14.5 band. Without a bass instrument, orchestral low brass can fill this register; that is not a label error. |
| Synth: `synth` | MVSep Synth 88, `add_opt1=0` | fair | 8.8 band; fails under an orchestra at −1.8, returning low brass instead of pads. |
| Piano: `piano` | MVSep Piano 29, `add_opt1=5` | fair | 5.7 with strings; piano and `keys` (5.5) are interchangeable on this test. |

Mega 53-stem 126 is a quick look at what is present: one job returns 14–22 detected files, but each trails the dedicated route (drums 1.9 vs 5.5; strings 1.4 vs 1.7). It is not an extract stem id in this catalog. Check the route tool for available choices; use the dedicated routes for keepers.

## How far to split a family

| Family | Useful granularity | Evidence |
|---|---|---|
| Drums | Kit pieces on a band kit; whole group for orchestral percussion | Group 24.0 band; DrumSep 37 option 7 gives kick 12.8 and hi-hat 11.4. Snare, toms, ride and crash were not measurable here. Kit pieces score near 0 on orchestral percussion. |
| Strings | Stop at `strings` on orchestral material | Group 3.1–3.6; violin 0.4–0.5, cello 0.3–1.1 (Mega). |
| Brass | Stop at `brass` on orchestral material; even the group is rough | Group 1.6–2.1; French horn 0.6–1.4, trumpet 0.1–0.2, trombone 0.2–0.5. |
| Vocals | All vocals for a keeper; lead/backing when a lead is needed | All vocals 11.4 band; lead 5.5, backing about 0. Karaoke 49 option 6 measured lead + backing together at 5.1. |
| Keys | `piano` or `keys` | Piano 5.7, keys 5.5; no finer measurement here. |

Do not promise usable solo strings or brass from a dense orchestra just because the catalog has an instrument id. Woodwinds and most individual routes remain untested.

## Catalog ids and bundles

Pass these group ids through `stems`: `drums_full`, `percussion`, `vocals_all`, `choir`, `brass`, `woodwind`, `strings`, `keys`, `guitar`.

For non-vocal bundles, selecting any member delivers the whole bundle in one job:

- Drum kit (`drumsep` route, 37, `add_opt1=7`, `add_opt2=0`): `drum_kick`, `drum_snare`, `drum_toms`, `drum_hihats`, `drum_cymbals_crash`, `drum_cymbals_ride`.
- Lead/rhythm guitar (`lead_rhythm_guitar` route): `guitar_lead`, `guitar_rhythm` (untested).

Vocal bundles use options, not direct selection in `stems`:

- `vocalMode: "lead_back"` (`lead_back_vocal` route): `vocal_lead`, `vocal_back` (fair). The planner uses the original-mix mode, or the dry-vocal mode after dereverb.
- `vocalMode: "male_female"` (`male_female_vocal` route): `vocal_male`, `vocal_female` (untested).
- `includeReverb: true` (`dereverb` route): `vocal_reverb`; without a vocal mode it also delivers `vocal_dry` (untested). With a vocal mode, that bundle runs on the dry vocal. Dereverb adds one job.

Other individual `stems` ids, available when the material and goal justify them:

- Keyboards: `piano`, `digital_piano`, `organ`, `accordion`, `harpsichord`.
- Winds: `saxophone`, `flute`, `trumpet`, `trombone`, `french_horn`, `tuba`, `clarinet`, `oboe`, `bassoon`, `harmonica`.
- Plucked strings: `guitar_acoustic`, `guitar_electric`, `mandolin`, `banjo`, `ukulele`, `harp`, `sitar`, `dobro`.
- Bowed strings: `violin`, `viola`, `cello`, `double_bass`.
- Percussion: `bells`, `congas`, `tambourine`, `marimba`, `glockenspiel`, `timpani`, `triangle`, `wind_chimes`.
- Low end / electronic: `bass`, `synth`.

Extraction also delivers `other` (Other) locally for free: the track minus every stem pulled out in that split. It is not a paid selection. The route tool and `packages/shared/src/extract-catalog.ts` are the current contract for ids and plans.

## Checks before saving

Every provider result is checked before its stems are saved. Aurora gives each job a unique upload name, verifies the returned algorithm, and resolves exact output keys against MVSEP's labels. A wrong algorithm, missing or duplicate key, or contradicting label stops the job.

The route's audio checks then test the required outputs against the input or drum bus. Where a sum check applies, its error must be within −20 dB of the whole and −12 dB of the quietest part. Checks catch a complement retaining its target, or a target that is the whole input while the rest is not silent. Family tests compare transients for drums/percussion, low end for bass, and lower low-end share for vocals/choir. Some bundle and from-part routes cannot sum to the whole input; the route tool describes which checks apply. Audio checks use up to 60 seconds from the middle of the track.

**A failed identity or audio check saves nothing from that job.** Its temporary downloads are removed and the reason names the cause. Earlier successful jobs in a multi-job run can already have landed. Read the reason before trying again: re-running submits another paid job.

A pass does not prove isolation or quality. A clean audio-content label swap in **brass, strings, keys or guitar** is not detectable: those families have no cheap distinguishing test. Their exact-key identity checks and available sum checks still apply. Audition them, and do not mistake bleed for an identity failure. A local recheck also cannot recover missing provider identity metadata.

## Cost

MVSEP charges **`max(1, floor(seconds × coefficient / 60))` premium minutes per job**. The coefficient is route-dependent. At coefficient 1, a 15-second test costs the same one premium minute as 60 seconds; shortening a test below that floor does not save a minute. Do not treat Aurora's rounded duration estimate or future pack credits as the provider's actual debit.

A group is one job; a selected bundle is one job however many members it delivers; each individual route is one job; the fixed seven-stem split is three jobs. Check the free extraction plan before authorization and balances before/after a paid batch. No automatic paid retries after a failed check; see `aurora-cost-discipline`.
