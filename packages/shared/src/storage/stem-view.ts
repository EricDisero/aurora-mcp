import { existsSync } from 'node:fs'
import { normalizeStemId, STEM_LABELS } from '../types.js'
import { EXTRACT_STEM_LABELS } from '../extract-catalog.js'
import type { LaneView, StemSetView, StemType, StemView } from '../types.js'
import type { Recipe } from '../recipe.js'
import { getAsset } from './assets.js'
import { getStems } from './stems.js'
import { getExtractionStems } from './extractions.js'
import { listStoredSets } from './stem-sets.js'

// Port of aurora/src/main/storage/stem-view.ts.
const DRUM_ORDER = ['kick', 'snare', 'hats', 'toms', 'crash', 'ride']
const EXTRACT_DRUM_ORDER = [
  'drum_kick', 'drum_snare', 'drum_hihats', 'drum_toms', 'drum_cymbals_crash', 'drum_cymbals_ride'
]
const CATALOG_ORDER = Object.keys(EXTRACT_STEM_LABELS)

function isDrum(stemKey: string): boolean {
  return DRUM_ORDER.includes(stemKey) || stemKey.startsWith('drum_')
}

function laneOrder(stemKey: string): number {
  if (stemKey === 'other') return Number.MAX_SAFE_INTEGER
  if (stemKey === 'vocals') return 0
  if (stemKey === 'bass') return 1
  const drumIndex = Math.max(DRUM_ORDER.indexOf(stemKey), EXTRACT_DRUM_ORDER.indexOf(stemKey))
  if (drumIndex >= 0) return 2 + drumIndex
  if (isDrum(stemKey)) return 8
  const catalogIndex = CATALOG_ORDER.indexOf(stemKey)
  return 9 + (catalogIndex < 0 ? CATALOG_ORDER.length : catalogIndex)
}

function lane(setKey: string, stemKey: string, label: string, path: string, sortOrder: number, recipe: Recipe): LaneView {
  stemKey = normalizeStemId(stemKey)
  return {
    laneId: `${setKey}:${stemKey}`,
    stemKey,
    label,
    path,
    available: existsSync(path),
    group: isDrum(stemKey) ? 'drums' : null,
    sortOrder,
    recipe
  }
}

function orderDerived(lanes: LaneView[]): LaneView[] {
  return lanes.sort((a, b) => laneOrder(a.stemKey) - laneOrder(b.stemKey)
    || a.stemKey.localeCompare(b.stemKey)).map((item, index) => ({ ...item, sortOrder: index }))
}

export function getStemView(assetId: string): StemView {
  const asset = getAsset(assetId)
  if (!asset) throw new Error(`Asset not found: ${assetId}`)
  const sets: StemSetView[] = []
  const stems = getStems(assetId)
  if (stems.length) {
    sets.push({
      key: 'split', kind: 'split', name: 'Split',
      lanes: orderDerived(stems.map((stem) => {
        const key = normalizeStemId(stem.stemType)
        return lane('split', key, STEM_LABELS[key as StemType], stem.path, 0, stem.recipe)
      }))
    })
  }
  const extractions = getExtractionStems(assetId)
  if (extractions.length) {
    sets.push({
      key: 'extraction', kind: 'extraction', name: 'Extraction',
      lanes: orderDerived(extractions.map((stem) => {
        const key = normalizeStemId(stem.stemId)
        return lane('extraction', key, EXTRACT_STEM_LABELS[key] ?? key, stem.path, 0, stem.recipe)
      }))
    })
  }
  for (const set of listStoredSets(assetId)) {
    const key = `set:${set.id}`
    sets.push({
      key, kind: set.kind, name: set.name,
      lanes: set.lanes.map((item) => lane(key, item.stemKey, item.label, item.path, item.sortOrder, set.recipe))
        .sort((a, b) => Number(a.stemKey === 'other') - Number(b.stemKey === 'other')
          || a.sortOrder - b.sortOrder)
    })
  }
  return {
    asset: { id: asset.id, projectId: asset.projectId, trackId: asset.trackId ?? null, name: asset.name, path: asset.path },
    sets
  }
}
