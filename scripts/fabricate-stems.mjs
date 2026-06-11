// Fabricate a mechanically-valid split set for the UC4 dry run WITHOUT spending
// MVSEP credits: copy the verification asset's WAV as all 7 stems + DB rows.
// The engine/analyze path only needs 7 decodable, sample-aligned WAVs — content
// equality is irrelevant for a mechanical click-through. Cleanup: pass --clean.
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getDb } from '../packages/shared/dist/db.js'
import { getAsset, getAssetStemsDir } from '../packages/shared/dist/storage/assets.js'
import { upsertStem } from '../packages/shared/dist/storage/stems.js'

const ASSET_ID = process.argv[2]
const CLEAN = process.argv.includes('--clean')
if (!ASSET_ID) {
  console.error('usage: node fabricate-stems.mjs <assetId> [--clean]')
  process.exit(1)
}

const asset = getAsset(ASSET_ID)
if (!asset) throw new Error(`asset not found: ${ASSET_ID}`)
const stemsDir = getAssetStemsDir(asset)
const STEMS = ['vocals', 'kick', 'snare', 'toms', 'hats', 'bass', 'ee']

if (CLEAN) {
  getDb().prepare('DELETE FROM project_stems WHERE asset_id = ?').run(ASSET_ID)
  await rm(stemsDir, { recursive: true, force: true })
  console.log(`cleaned fabricated stems for ${asset.name}`)
} else {
  if (!asset.path.toLowerCase().endsWith('.wav')) throw new Error('need a WAV asset')
  await mkdir(stemsDir, { recursive: true })
  await copyFile(asset.path, join(stemsDir, 'original.wav'))
  for (const st of STEMS) {
    const p = join(stemsDir, `${st}.wav`)
    await copyFile(asset.path, p)
    upsertStem({
      projectId: asset.projectId,
      assetId: ASSET_ID,
      stemType: st,
      path: p,
      origin: st === 'hats' || st === 'ee' ? 'synthesized' : 'mvsep'
    })
  }
  console.log(`fabricated 7 stems for "${asset.name}" in ${stemsDir}`)
}
