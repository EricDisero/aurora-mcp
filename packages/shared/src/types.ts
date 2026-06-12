// Aurora domain types — mirrored from aurora/src/shared/types/index.ts (the
// locked contract). The MCP works against the SAME DB + project folders as the
// app, so these shapes must stay in lockstep with the app's schema v2.

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

export type AssetKind = 'generation' | 'cover' | 'import' | 'reference' | 'master'

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
}

export const STEM_TYPES = ['vocals', 'kick', 'snare', 'toms', 'hats', 'bass', 'ee'] as const
export type StemType = (typeof STEM_TYPES)[number]

export interface ProjectStem {
  id: string
  projectId: string
  assetId: string
  stemType: StemType
  path: string
  origin: 'mvsep' | 'synthesized'
}

/** A Sample Extractor result stem (schema v2 extraction_stems). stemId is a
 *  catalog id from extract-catalog.ts (piano / vocal_lead / drum_kick / ee…). */
export interface ExtractionStem {
  id: string
  projectId: string
  assetId: string
  stemId: string
  path: string
  /** Krumhansl-Schmuckler result, e.g. "C major / A minor" (null = not detected). */
  detectedKey: string | null
  createdAt: number
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

/** A single MVSEP job spec (see aurora docs/build-specs/mvsep-separation-contract.md). */
export interface MvsepJobSpec {
  sep_type: string
  output_format: string
  is_demo: string
  add_opt1?: string
  add_opt2?: string
}

export interface SeparationResultFile {
  url: string
  filename: string
}
