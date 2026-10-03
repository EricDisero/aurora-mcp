// Free route inspection and replay of the canonical audio checks. No provider requests.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { decodeWav } from './audio/wav.js'
import { ALL_ROUTES, SPLIT_ROUTES, GROUP_ROUTES, INSTRUMENT_ROUTES, type SeparationRoute } from './separation/routes.js'
import { MVSEP_ALGORITHMS, MVSEP_CATALOG_DATE } from './separation/mvsep-catalog.generated.js'
import { checkLocalOutputs, routeOutputKeys, routeSpec, type RouteRun } from './separation/run-route.js'
import { resolveOutputs } from './separation/identify.js'
import { CONTENT_THRESHOLDS } from './separation/content-check.js'
import type { SeparationCheckRecord, SeparationResult } from './types.js'
import { MvsepError } from './providers/mvsep.js'

export interface SeparationRouteInfo extends SeparationRoute {
  algorithm: string | null
  surface: 'split' | 'extract group' | 'extract instrument' | 'extract bundle'
}

function getRoute(routeId: string): SeparationRoute {
  const route = ALL_ROUTES[routeId]
  if (!route) throw new MvsepError('SEPARATION_ROUTE_UNKNOWN', `Unknown separation route: ${routeId}`, false,
    'Use listSeparationRoutes for the available route ids.', 'planning')
  return route
}

export function listSeparationRoutes(): SeparationRouteInfo[] {
  const splitIds = new Set(Object.values(SPLIT_ROUTES).map((route) => route.id))
  const groupIds = new Set(Object.values(GROUP_ROUTES).map((route) => route.id))
  const instrumentIds = new Set(Object.values(INSTRUMENT_ROUTES).map((route) => route.id))
  return Object.values(ALL_ROUTES).map((route) => ({
    ...structuredClone(route), algorithm: MVSEP_ALGORITHMS[route.sepType]?.name ?? null,
    surface: splitIds.has(route.id) ? 'split' : groupIds.has(route.id) ? 'extract group' :
      instrumentIds.has(route.id) ? 'extract instrument' : 'extract bundle'
  }))
}

export function planSeparationRoute(routeId: string): {
  routeId: string; sep_type: string; output_format: string; is_demo: string;
  options: SeparationRoute['options']; outputKeys: string[]
} {
  const route = getRoute(routeId)
  const spec = routeSpec(route)
  return { routeId, sep_type: spec.sep_type, output_format: spec.output_format, is_demo: spec.is_demo,
    options: { ...route.options }, outputKeys: routeOutputKeys(route) }
}

/** Persist checking provenance without provider download URLs. Auxiliary outputs discarded by the
 * canonical runner are explicitly unavailable for a later replay. */
export function describeSeparationResult(
  routeId: string, result: SeparationResult, run: RouteRun
): SeparationCheckRecord {
  const route = getRoute(routeId)
  const keys = routeOutputKeys(route)
  const { byKey } = resolveOutputs(route.sepType, result.files, keys, result.algorithm)
  const paths: Record<string, string> = { ...run.kept }
  for (const [stemId, key] of Object.entries(route.delivers)) paths[key] = run.stems[stemId]
  const unavailableReplayKeys = keys.filter((key) => !paths[key])
  const limitations = ['A pass means the recorded checks passed on the recorded window; it is not proof of musical purity.']
  if (!result.algorithm) limitations.push('The provider returned no algorithm metadata; that cross-check was unavailable.')
  if (keys.some((key) => !byKey[key].label)) limitations.push('Some provider type labels were unavailable.')
  if (route.family.family === 'none') limitations.push('A clean label swap cannot be detected for this family: names and sums only.')
  if (unavailableReplayKeys.length) limitations.push('Full local replay requires auxiliary checking outputs that the canonical runner did not retain.')
  return { notes: run.notes, metrics: run.metrics, checkWindowSeconds: run.checkWindowSeconds,
    routeDigest: createHash('sha256').update(JSON.stringify(route)).digest('hex'), catalogDate: MVSEP_CATALOG_DATE,
    thresholds: { ...CONTENT_THRESHOLDS }, algorithm: result.algorithm,
    outputs: keys.map((key) => ({ key, filename: byKey[key].filename, label: byKey[key].label, path: paths[key] })),
    unavailableReplayKeys, limitations }
}

export async function checkSeparationOutputs(input: {
  routeId: string; inputPath: string; outputs: Record<string, string>
}): Promise<{
  ok: boolean; problems: string[]; notes: string[]; metrics: Record<string, number>;
  checkWindowSeconds: number; limitations: string[]
}> {
  const route = getRoute(input.routeId)
  const limitations = ['Local replay has no provider algorithm or type labels; it runs audio checks on the supplied output keys. A pass is not proof of musical purity.']
  if (route.family.family === 'none') limitations.push(
    'A clean label swap cannot be detected for this family: the route relies on names and sums only.'
  )
  if (route.sums.length === 0) limitations.push('This route declares no sum check.')
  const problems = routeOutputKeys(route).filter((key) => !input.outputs[key]).map((key) => `Missing checking output: ${key}`)
  if (problems.length > 0) return { ok: false, problems, notes: [], metrics: {}, checkWindowSeconds: 0, limitations }
  try {
    const [original, entries] = await Promise.all([
      readFile(input.inputPath),
      Promise.all(Object.entries(input.outputs).map(async ([key, path]) => [key, await readFile(path)] as const))
    ])
    const wav = decodeWav(original)
    for (const [key, bytes] of entries) {
      const output = decodeWav(bytes)
      if (output.sampleRate !== wav.sampleRate || output.frames !== wav.frames || output.channels.length !== wav.channels.length) {
        problems.push(`${key}: sample rate, length or channel count differs from the input`)
      }
    }
    if (wav.frames === 0 || wav.sampleRate <= 0 || wav.channels.length === 0) problems.push('The input WAV contains no valid audio.')
    if (problems.length > 0) return { ok: false, problems, notes: [], metrics: {}, checkWindowSeconds: 0, limitations }
    return { ...checkLocalOutputs(route, original, Object.fromEntries(entries)), limitations }
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)],
      notes: [], metrics: {}, checkWindowSeconds: 0, limitations }
  }
}
