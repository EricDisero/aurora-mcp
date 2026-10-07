import type { Recipe } from './recipe.js'

// Aurora domain types — mirrored from aurora/src/shared/types/index.ts (the
// locked contract). The MCP works against the SAME DB + project folders as the
// app, so these shapes must stay in lockstep with its schema.

export interface Project {
  id: string
  name: string
  /** Folder name under the projects root. Human-readable slug for new projects;
   *  legacy projects keep their uuid folder. */
  dirName: string
  createdAt: number
  updatedAt: number
}

/** A subfolder inside a project (a "track" in a multi-track release). Schema v3.
 *  Track-assigned assets nest on disk as <proj>/<track dirName>/{generations,…};
 *  unfiled assets (track_id NULL) stay flat at the project root. */
export interface Track {
  id: string
  projectId: string
  name: string
  dirName: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export type AssetKind = 'generation' | 'cover' | 'track' | 'master'

export interface ProjectAsset {
  id: string
  projectId: string
  /** Track (project subfolder) this asset belongs to; null = unfiled. */
  trackId?: string | null
  kind: AssetKind
  name: string
  /** Absolute path to the audio file on disk. */
  path: string
  origin?: Record<string, unknown> | null
  sourceAssetId?: string | null
  refId?: string | null
  /** Persisted favorite flag (schema v3). */
  favorite: boolean
  createdAt: number
  recipe: Recipe
}

export const STEM_TYPES = ['vocals', 'kick', 'snare', 'toms', 'hats', 'bass', 'other'] as const
export type StemType = (typeof STEM_TYPES)[number]

export const STEM_LABELS: Record<StemType, string> = {
  vocals: 'Vocals', kick: 'Kick', snare: 'Snare', toms: 'Toms',
  hats: 'Hats', bass: 'Bass', other: 'Other'
}

export interface StemLaneInput {
  stemKey: string
  label: string
  path: string
}

export interface StoredStemLane extends StemLaneInput {
  id: string
  setId: string
  sortOrder: number
}

export interface StoredStemSet {
  id: string
  projectId: string
  assetId: string
  kind: 'import' | 'custom'
  name: string
  sourcePath: string | null
  createdAt: number
  lanes: StoredStemLane[]
  recipe: Recipe
}

export interface CreateStemSetParams {
  projectId: string
  assetId: string
  kind: 'import' | 'custom'
  name: string
  sourcePath?: string
  lanes: StemLaneInput[]
  recipe?: Recipe | null
}

export interface CreateStemSetRequest {
  assetId: string
  name: string
  lanes: { stemKey: string; label?: string; path: string }[]
}

export interface LaneView extends StemLaneInput {
  laneId: string
  available: boolean
  group: 'drums' | null
  sortOrder: number
  /** What made this lane's file: its stem row's recipe, or its stored set's. */
  recipe?: Recipe
}

export interface StemSetView {
  key: string
  kind: 'split' | 'extraction' | 'import' | 'custom'
  name: string
  lanes: LaneView[]
}

export interface StemView {
  asset: { id: string; projectId: string; trackId: string | null; name: string; path: string }
  sets: StemSetView[]
}

export interface ImportSplitJobRequest {
  jobJsonPath: string
  assetId?: string
  name?: string
}

export interface ImportSplitJobResult {
  set: StoredStemSet
  reused: boolean
  skipped: Array<{ label: string; path: string; reason: string }>
}

/** Accept the deprecated stem id at persisted-data and agent-input boundaries. */
export function normalizeStemId(id: string): string {
  return id === 'ee' ? 'other' : id
}

export interface ProjectStem {
  id: string
  projectId: string
  assetId: string
  stemType: StemType
  path: string
  origin: 'mvsep' | 'synthesized' | 'imported'
  recipe: Recipe
}

/** A Sample Extractor result stem (schema v2 extraction_stems). stemId is a
 *  catalog id from extract-catalog.ts (piano / vocal_lead / drum_kick / other…). */
export interface ExtractionStem {
  id: string
  projectId: string
  assetId: string
  stemId: string
  path: string
  /** Krumhansl-Schmuckler result, e.g. "C major / A minor" (null = not detected). */
  detectedKey: string | null
  createdAt: number
  recipe: Recipe
}

export interface ReferenceTrack {
  id: string
  name: string
  audioPath: string
  cachedCurvePath: string | null
  curveStatus: 'none' | 'analyzing' | 'cached' | 'error'
  createdAt: number
}

export interface AppSettings {
  projectsDirectory: string
  outputDirectory: string
  defaultGenModel: string
  defaultSmoothing: number
  defaultBitDepth: 16 | 24 | 32
}

export type { MvsepJobSpec, SeparationResultFile, SeparationResult, SeparationProvider } from './separation/contracts.js'

/** Safe to show an agent or persist in a job manifest. */
export interface JobError {
  code: string
  message: string
  retryable: boolean
  nextAction: string
  stage?: string
  httpStatus?: number
}

/** One logical paid call. A submitting attempt without a hash must be reconciled, never recreated. */
export interface SeparationAttempt {
  routeId: string
  status: 'pending' | 'submitting' | 'accepted' | 'landed' | 'failed' | 'uncertain'
  uploadName?: string
  spec?: import('./separation/contracts.js').MvsepJobSpec
  hash?: string
  inputPath?: string
  inputDigest?: string
  submittedAt?: string
  deliveredStemIds: string[]
  error?: JobError
  checks?: SeparationCheckRecord
}

export interface SeparationCheckRecord {
  notes: string[]
  metrics: Record<string, number>
  checkWindowSeconds: number
  routeDigest: string
  catalogDate: string
  thresholds: Record<string, number>
  algorithm: string | null
  outputs: Array<{ key: string; filename: string; label?: string; path?: string }>
  unavailableReplayKeys: string[]
  limitations: string[]
}
