// Sample Extractor catalog + call planning — ported VERBATIM from prism's
// sample_worker.py (STEM_BUNDLES lines 222-247, INDIVIDUAL_STEMS 249-295,
// plan_api_calls 739-838, _identify_output_files 631-733) and the extraction
// half of frontend/src/lib/credits-calculator.ts. Pure logic, no IO — shared by
// the main-process orchestrator AND the renderer cost card.
//
// LOCKSTEP: this is the identical copy of aurora's src/shared/extract-catalog.ts
// (storage-semantics lockstep rule). Behavior changes go into BOTH files or
// neither.

export interface ExtractBundleConfig {
  stems: string[]
  sepType: number
  addOpt1?: number
  addOpt2?: number
}

// Bundled stems — one MVSEP call returns multiple stems.
export const EXTRACT_BUNDLES: Record<string, ExtractBundleConfig> = {
  drumsep: {
    stems: [
      'drum_kick',
      'drum_snare',
      'drum_toms',
      'drum_hihats',
      'drum_cymbals_crash',
      'drum_cymbals_ride'
    ],
    sepType: 37,
    addOpt1: 7,
    addOpt2: 0
  },
  // add_opt2=1 for original input, 0 for dry (post-dereverb) input — the
  // planner sets it per run.
  lead_back_vocal: { stems: ['vocal_lead', 'vocal_back'], sepType: 49, addOpt1: 6, addOpt2: 1 },
  male_female_vocal: { stems: ['vocal_male', 'vocal_female'], sepType: 57, addOpt1: 3, addOpt2: 1 },
  lead_rhythm_guitar: { stems: ['guitar_lead', 'guitar_rhythm'], sepType: 101, addOpt1: 0 },
  // Dereverb exists as a "bundle" for call counting (dry + reverb in one call).
  dereverb: { stems: ['vocal_dry', 'vocal_reverb'], sepType: 22, addOpt1: 6, addOpt2: 0 }
}

export interface IndividualStemConfig {
  sepType: number
  addOpt1?: number
  addOpt2?: number
  /** EXACT filename pattern MVSEP returns (lowercase, hyphens). */
  mvsepName: string
}

// Individual stems — one MVSEP call per stem.
export const EXTRACT_INDIVIDUAL_STEMS: Record<string, IndividualStemConfig> = {
  // Keys
  piano: { sepType: 29, addOpt1: 5, mvsepName: 'piano' },
  digital_piano: { sepType: 79, mvsepName: 'digital-piano' },
  organ: { sepType: 58, addOpt1: 3, mvsepName: 'organ' },
  accordion: { sepType: 99, mvsepName: 'accordion' },
  harpsichord: { sepType: 91, mvsepName: 'harpsichord' },
  // Wind
  saxophone: { sepType: 61, addOpt1: 3, addOpt2: 1, mvsepName: 'saxophone' },
  flute: { sepType: 67, addOpt1: 1, addOpt2: 1, mvsepName: 'flute' },
  trumpet: { sepType: 71, addOpt2: 1, mvsepName: 'trumpet' },
  trombone: { sepType: 75, addOpt2: 1, mvsepName: 'trombone' },
  french_horn: { sepType: 82, addOpt2: 1, mvsepName: 'french-horn' },
  tuba: { sepType: 92, addOpt2: 1, mvsepName: 'tuba' },
  clarinet: { sepType: 78, addOpt2: 1, mvsepName: 'clarinet' },
  oboe: { sepType: 77, addOpt2: 1, mvsepName: 'oboe' },
  bassoon: { sepType: 93, addOpt2: 1, mvsepName: 'bassoon' },
  harmonica: { sepType: 87, addOpt2: 1, mvsepName: 'harmonica' },
  // Plucked — NOTE: MVSEP uses 'acoustic-guitar', not 'guitar-acoustic'.
  guitar_acoustic: { sepType: 66, addOpt2: 1, mvsepName: 'acoustic-guitar' },
  guitar_electric: { sepType: 81, addOpt2: 1, mvsepName: 'electric-guitar' },
  mandolin: { sepType: 74, mvsepName: 'mandolin' },
  banjo: { sepType: 83, mvsepName: 'banjo' },
  ukulele: { sepType: 96, mvsepName: 'ukulele' },
  harp: { sepType: 72, mvsepName: 'harp' },
  sitar: { sepType: 90, mvsepName: 'sitar' },
  dobro: { sepType: 97, mvsepName: 'dobro' },
  // Bowed
  violin: { sepType: 65, addOpt2: 1, mvsepName: 'violin' },
  viola: { sepType: 69, addOpt2: 1, mvsepName: 'viola' },
  cello: { sepType: 70, addOpt2: 1, mvsepName: 'cello' },
  double_bass: { sepType: 73, addOpt2: 1, mvsepName: 'double-bass' },
  // Percussion
  bells: { sepType: 95, mvsepName: 'bells' },
  congas: { sepType: 94, mvsepName: 'congas' },
  tambourine: { sepType: 76, mvsepName: 'tambourine' },
  marimba: { sepType: 84, mvsepName: 'marimba' },
  glockenspiel: { sepType: 85, mvsepName: 'glockenspiel' },
  timpani: { sepType: 86, mvsepName: 'timpani' },
  triangle: { sepType: 89, mvsepName: 'triangle' },
  wind_chimes: { sepType: 98, mvsepName: 'wind-chimes' },
  // Other
  bass: { sepType: 41, addOpt1: 5, addOpt2: 1, mvsepName: 'bass' },
  synth: { sepType: 88, addOpt1: 1, mvsepName: 'synth' }
}

/** Vocal stems are driven by vocalMode/includeReverb, never by direct selection. */
export const VOCAL_STEM_IDS = new Set([
  'vocal_lead',
  'vocal_back',
  'vocal_male',
  'vocal_female',
  'vocal_dry',
  'vocal_reverb'
])

export type VocalSeparationType = 'lead_back' | 'male_female' | null

export interface ExtractSelection {
  /** Non-vocal stem ids (orb selection). Category markers are filtered upstream. */
  stems: string[]
  vocalSeparationType: VocalSeparationType
  includeReverb: boolean
}

export interface PlannedApiCall {
  type: 'dereverb' | 'vocal_bundle' | 'bundle' | 'individual'
  /** bundle/vocal_bundle: EXTRACT_BUNDLES key. individual: the stem id. */
  id: string
  sepType: number
  addOpt1?: number
  addOpt2?: number
  /** 'original' | 'dry' — dry chains the dereverbed vocal into a vocal bundle. */
  inputSource: 'original' | 'dry'
  /** Identification ruleset for the result files. */
  outputType: string
  /** dereverb only: deliver vocal_dry as a stem (reverb-only mode, no vocal bundle). */
  deliverVocalDry?: boolean
}

export interface ExtractPlan {
  calls: PlannedApiCall[]
  /** Stem ids this run delivers (ALWAYS ends with 'ee' — free, local, undeselectable). */
  stemsToDeliver: string[]
}

/** Port of sample_worker.plan_api_calls — convert a selection into the
 *  optimized MVSEP call plan. EE is always delivered (local phase-cancel). */
export function planApiCalls(selection: ExtractSelection): ExtractPlan {
  const calls: PlannedApiCall[] = []
  const stemsToDeliver: string[] = []
  let dereverbRan = false

  // Step 0: dereverb. ALWAYS BSRoformer (add_opt1=6) — MelRoformer is broken
  // via the MVSEP API (works on their web UI, returns wrong files via API).
  if (selection.includeReverb) {
    const deliverVocalDry = selection.vocalSeparationType === null
    calls.push({
      type: 'dereverb',
      id: 'dereverb',
      sepType: 22,
      addOpt1: 6,
      addOpt2: 0,
      inputSource: 'original',
      outputType: 'dereverb',
      deliverVocalDry
    })
    stemsToDeliver.push('vocal_reverb')
    if (deliverVocalDry) stemsToDeliver.push('vocal_dry')
    dereverbRan = true
  }

  // Step 1: vocal separation bundle.
  if (selection.vocalSeparationType) {
    const bundleId =
      selection.vocalSeparationType === 'lead_back' ? 'lead_back_vocal' : 'male_female_vocal'
    const bundle = EXTRACT_BUNDLES[bundleId]
    calls.push({
      type: 'vocal_bundle',
      id: bundleId,
      sepType: bundle.sepType,
      addOpt1: bundle.addOpt1,
      // add_opt2: 1 against the original, 0 against the dereverbed dry vocal.
      addOpt2: dereverbRan ? 0 : 1,
      inputSource: dereverbRan ? 'dry' : 'original',
      outputType: selection.vocalSeparationType
    })
    stemsToDeliver.push(...bundle.stems)
  }

  // Step 2: non-vocal bundles (drums, guitars) — any selected member pulls the
  // whole bundle in ONE call.
  const covered = new Set<string>()
  for (const bundleId of ['drumsep', 'lead_rhythm_guitar'] as const) {
    const bundle = EXTRACT_BUNDLES[bundleId]
    const requested = bundle.stems.filter((s) => selection.stems.includes(s))
    if (requested.length > 0) {
      calls.push({
        type: 'bundle',
        id: bundleId,
        sepType: bundle.sepType,
        addOpt1: bundle.addOpt1,
        addOpt2: bundle.addOpt2,
        inputSource: 'original',
        outputType: bundleId,
        // prism delivered the full bundle; we keep that (you paid for the call).
      })
      stemsToDeliver.push(...bundle.stems)
      for (const s of bundle.stems) covered.add(s)
    }
  }

  // Step 3: individual stems.
  for (const stemId of selection.stems) {
    if (!covered.has(stemId) && EXTRACT_INDIVIDUAL_STEMS[stemId]) {
      const cfg = EXTRACT_INDIVIDUAL_STEMS[stemId]
      calls.push({
        type: 'individual',
        id: stemId,
        sepType: cfg.sepType,
        addOpt1: cfg.addOpt1,
        addOpt2: cfg.addOpt2,
        inputSource: 'original',
        outputType: stemId
      })
      stemsToDeliver.push(stemId)
    }
  }

  // EE is always generated and delivered (free, local).
  stemsToDeliver.push('ee')

  return { calls, stemsToDeliver }
}

/** Port of sample_worker._identify_output_files — map MVSEP result files to
 *  stem keys by URL-filename pattern, NEVER by array position. Returns
 *  stemKey → url. Throws when nothing matches (clear failure beats silence). */
export function identifyOutputFiles(
  files: Array<{ url: string; filename: string }>,
  outputType: string
): Record<string, string> {
  const results: Record<string, string> = {}

  for (const f of files) {
    const url = f.url
    if (!url) continue
    const name = (f.filename || url.split('/').pop() || '').toLowerCase()

    if (outputType === 'drumsep') {
      // MVSEP returns: kick, snare, toms, hh, crash, ride.
      if (name.includes('kick')) results.drum_kick = url
      else if (name.includes('snare')) results.drum_snare = url
      else if (name.includes('toms')) results.drum_toms = url
      else if (
        name.includes('_hh_') ||
        name.includes('_hh.') ||
        name.includes('-hh_') ||
        name.includes('-hh.')
      )
        results.drum_hihats = url
      else if (name.includes('crash')) results.drum_cymbals_crash = url
      else if (name.includes('ride')) results.drum_cymbals_ride = url
    } else if (outputType === 'dereverb') {
      // BSRoformer output: noreverb (dry vocal), reverb (tail). 'dereverb'
      // CONTAINS 'reverb', so boundary checks are mandatory. We do NOT use
      // 'instrum' — it is not phase-accurate for summing back to the original.
      if (name.includes('_dry_') || name.endsWith('_dry.wav')) results.vocal_dry = url
      else if (name.includes('_noreverb_') || name.endsWith('_noreverb.wav'))
        results.vocal_dry = url
      else if (name.includes('_other_') || name.endsWith('_other.wav'))
        results.vocal_reverb = url
      else if (name.includes('_reverb_[mvsep') || name.endsWith('_reverb.wav'))
        results.vocal_reverb = url
    } else if (outputType === 'lead_back') {
      // Returns: vocals-full, vocals-lead, vocals-back, instrum-only, back-instrum.
      if (name.includes('vocals-lead') || name.includes('vocals_lead')) results.vocal_lead = url
      else if (name.includes('vocals-back') || name.includes('vocals_back'))
        results.vocal_back = url
    } else if (outputType === 'male_female') {
      // Filenames END with _male.wav / _female.wav; exclude instrumental-plus-*.
      if (name.endsWith('_male.wav') && !name.includes('instrumental-plus'))
        results.vocal_male = url
      else if (name.endsWith('_female.wav') && !name.includes('instrumental-plus'))
        results.vocal_female = url
    } else if (outputType === 'lead_rhythm_guitar') {
      if (name.includes('lead-guitar') || name.includes('lead_guitar')) results.guitar_lead = url
      else if (name.includes('rhythm-guitar') || name.includes('rhythm_guitar'))
        results.guitar_rhythm = url
    } else {
      // Individual stem — exact mvsepName match, excluding no_*/other files.
      const cfg = EXTRACT_INDIVIDUAL_STEMS[outputType]
      const mvsepName = cfg?.mvsepName ?? outputType.replace(/_/g, '-')
      if (name.includes(mvsepName) && !name.includes('no_') && !name.includes('other')) {
        results[outputType] = url
      }
    }
  }

  if (Object.keys(results).length === 0) {
    throw new Error(
      `Could not identify MVSEP output files for ${outputType}. Files: ${files
        .map((f) => f.filename)
        .join(', ')}`
    )
  }
  return results
}

// ── Cost math (port of credits-calculator.ts, extraction half) ──────────────
// Aurora's new credit model meters cloud calls; pack pricing is deferred, so
// the DISPLAY unit today is real provider units: MVSEP calls × ceil(minutes).
// The 10-credits/min/call constant survives for the future pack metering.

export const CREDITS_PER_MINUTE = 10

/** 0-1 min = 1x, 1-2 min = 2x, … */
export function getMinuteMultiplier(durationSeconds: number): number {
  if (durationSeconds <= 0) return 1
  return Math.ceil(durationSeconds / 60)
}

export interface ExtractCallBreakdown {
  bundles: { bundleId: string; stems: string[] }[]
  individualStems: string[]
  totalCalls: number
}

/** Breakdown for the cost card — derived from the REAL plan, so the count can
 *  never drift from what the orchestrator fires. */
export function getCallBreakdown(selection: ExtractSelection): ExtractCallBreakdown {
  const plan = planApiCalls(selection)
  const bundles: { bundleId: string; stems: string[] }[] = []
  const individualStems: string[] = []
  for (const call of plan.calls) {
    if (call.type === 'individual') individualStems.push(call.id)
    else bundles.push({ bundleId: call.id, stems: EXTRACT_BUNDLES[call.id]?.stems ?? [] })
  }
  return { bundles, individualStems, totalCalls: plan.calls.length }
}

export function countApiCalls(selection: ExtractSelection): number {
  return planApiCalls(selection).calls.length
}

export interface ExtractCostEstimate {
  totalCalls: number
  minuteMultiplier: number
  /** Future pack metering: calls × minutes × CREDITS_PER_MINUTE. */
  credits: number
  breakdown: ExtractCallBreakdown
}

export function estimateExtractCost(
  selection: ExtractSelection,
  durationSeconds: number = 60
): ExtractCostEstimate {
  const breakdown = getCallBreakdown(selection)
  const minuteMultiplier = getMinuteMultiplier(durationSeconds)
  return {
    totalCalls: breakdown.totalCalls,
    minuteMultiplier,
    credits: breakdown.totalCalls * minuteMultiplier * CREDITS_PER_MINUTE,
    breakdown
  }
}

// Human-readable bundle names for cost cards.
export const BUNDLE_DISPLAY_NAMES: Record<string, string> = {
  drumsep: 'Drum Kit',
  dereverb: 'Dry + Reverb',
  lead_back_vocal: 'Lead + Backing Vocals',
  male_female_vocal: 'Male + Female Vocals',
  lead_rhythm_guitar: 'Lead + Rhythm Guitar'
}

/** Display labels for every extractable stem id (orb names + vocal modes). */
export const EXTRACT_STEM_LABELS: Record<string, string> = {
  vocal_lead: 'Lead Vocal',
  vocal_back: 'Backing Vocals',
  vocal_male: 'Male Vocal',
  vocal_female: 'Female Vocal',
  vocal_dry: 'Dry Vocal',
  vocal_reverb: 'Reverb Tail',
  drum_kick: 'Kick',
  drum_snare: 'Snare',
  drum_toms: 'Toms',
  drum_hihats: 'Hi-Hats',
  drum_cymbals_crash: 'Crash',
  drum_cymbals_ride: 'Ride',
  guitar_lead: 'Lead Guitar',
  guitar_rhythm: 'Rhythm Guitar',
  guitar_acoustic: 'Acoustic Guitar',
  guitar_electric: 'Electric Guitar',
  piano: 'Piano',
  digital_piano: 'Digital Piano',
  organ: 'Organ',
  accordion: 'Accordion',
  harpsichord: 'Harpsichord',
  saxophone: 'Saxophone',
  flute: 'Flute',
  trumpet: 'Trumpet',
  trombone: 'Trombone',
  french_horn: 'French Horn',
  tuba: 'Tuba',
  clarinet: 'Clarinet',
  oboe: 'Oboe',
  bassoon: 'Bassoon',
  harmonica: 'Harmonica',
  mandolin: 'Mandolin',
  banjo: 'Banjo',
  ukulele: 'Ukulele',
  harp: 'Harp',
  sitar: 'Sitar',
  dobro: 'Dobro',
  violin: 'Violin',
  viola: 'Viola',
  cello: 'Cello',
  double_bass: 'Double Bass',
  bells: 'Bells',
  congas: 'Congas',
  tambourine: 'Tambourine',
  marimba: 'Marimba',
  glockenspiel: 'Glockenspiel',
  timpani: 'Timpani',
  triangle: 'Triangle',
  wind_chimes: 'Wind Chimes',
  bass: 'Bass',
  synth: 'Synth',
  ee: 'Everything Else'
}

/** Upload/duration caps — prism's cost protection, adopted. */
export const EXTRACT_MAX_DURATION_SECONDS = 12 * 60
