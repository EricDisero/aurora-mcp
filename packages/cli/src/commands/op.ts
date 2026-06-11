// `aurora run <op> --key value` dispatcher — port of the slates-mcp CLI's op
// command, including its best-effort Zod-aware scalar/array/null coercion.

import { ALL_OPERATIONS, type Operation } from '@ericdisero/aurora-shared'

interface RunOpOptions {
  opId: string
  rawArgs: string[]
  json: boolean
}

const RUN_COMMAND_FLAGS = new Set(['--json', '--list'])

export function listOps(): void {
  const ops = ALL_OPERATIONS as readonly Operation<unknown>[]
  for (const op of ops) {
    console.log(`${op.id}\n  ${op.description}\n`)
  }
  console.log(`${ops.length} operations. Run one with: aurora run <op> --key value`)
}

function parseArgs(rawArgs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]
    if (!arg.startsWith('--')) continue
    if (RUN_COMMAND_FLAGS.has(arg) || RUN_COMMAND_FLAGS.has(arg.split('=')[0])) {
      const next = rawArgs[i + 1]
      if (next != null && !next.startsWith('--')) i++
      continue
    }
    const eqIdx = arg.indexOf('=')
    if (eqIdx > 0) {
      assign(out, arg.slice(2, eqIdx), arg.slice(eqIdx + 1))
    } else {
      const key = arg.slice(2)
      const next = rawArgs[i + 1]
      if (next == null || next.startsWith('--')) {
        assign(out, key, true)
      } else {
        assign(out, key, next)
        i++
      }
    }
  }
  return out
}

function assign(obj: Record<string, unknown>, key: string, value: unknown): void {
  const existing = obj[key]
  if (existing == null) {
    obj[key] = value
    return
  }
  if (Array.isArray(existing)) {
    existing.push(value)
    return
  }
  obj[key] = [existing, value]
}

export async function runOp(opts: RunOpOptions): Promise<void> {
  const ops = ALL_OPERATIONS as readonly Operation<unknown>[]
  const op = ops.find((o) => o.id === opts.opId)
  if (!op) {
    console.error(`Unknown operation: ${opts.opId}`)
    console.error('Run `aurora run --list` to see all operations.')
    process.exit(1)
  }

  const raw = parseArgs(opts.rawArgs)
  const coerced = coerceForSchema(op.input, raw)

  let parsed: unknown
  try {
    parsed = op.input.parse(coerced)
  } catch (err) {
    console.error('Invalid arguments for', op.id)
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  const result = await op.run(parsed as never)

  if (opts.json) {
    process.stdout.write(JSON.stringify({ text: result.text, data: result.data }, null, 2))
    process.stdout.write('\n')
    return
  }
  console.log(result.text)
}

function coerceForSchema(schema: unknown, raw: Record<string, unknown>): Record<string, unknown> {
  type ZodLike = {
    _def?: {
      typeName?: string
      shape?: () => Record<string, ZodLike>
      innerType?: ZodLike
      schema?: ZodLike
      type?: ZodLike
    }
    shape?: Record<string, ZodLike>
  }
  const zodObj = schema as ZodLike
  if (zodObj?._def?.typeName !== 'ZodObject') return raw

  const shape: Record<string, ZodLike> =
    typeof zodObj._def.shape === 'function' ? zodObj._def.shape() : (zodObj.shape ?? {})

  const wrappers = new Set([
    'ZodOptional',
    'ZodDefault',
    'ZodNullable',
    'ZodReadonly',
    'ZodEffects',
    'ZodCatch',
    'ZodBranded'
  ])
  const unwrap = (t: ZodLike | undefined): ZodLike | undefined => {
    let cur = t
    let depth = 0
    while (cur?._def?.typeName && wrappers.has(cur._def.typeName) && depth < 8) {
      cur = cur._def.innerType ?? cur._def.schema
      depth++
    }
    return cur
  }
  const isNullable = (t: ZodLike | undefined): boolean => {
    let cur = t
    let depth = 0
    while (cur?._def?.typeName && depth < 8) {
      if (cur._def.typeName === 'ZodNullable') return true
      if (wrappers.has(cur._def.typeName)) {
        cur = cur._def.innerType ?? cur._def.schema
        depth++
        continue
      }
      break
    }
    return false
  }

  const coerceScalar = (fieldType: string, value: string): unknown => {
    if (fieldType === 'ZodNumber') {
      const n = Number(value)
      return Number.isFinite(n) ? n : value
    }
    if (fieldType === 'ZodBoolean') return value === 'true' || value === '1'
    return value
  }

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const declared = shape[key]
    const leaf = unwrap(declared)
    const fieldType = (leaf?._def?.typeName ?? '') as string

    if (value === 'null' && isNullable(declared)) {
      out[key] = null
      continue
    }

    if (fieldType === 'ZodArray') {
      const elemType = (leaf?._def?.type?._def?.typeName ?? '') as string
      const arr = Array.isArray(value)
        ? value
        : typeof value === 'string'
          ? value
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : [value]
      out[key] = arr.map((v) => (typeof v === 'string' ? coerceScalar(elemType, v) : v))
      continue
    }

    if (typeof value === 'string') {
      out[key] = coerceScalar(fieldType, value)
      continue
    }
    out[key] = value
  }
  return out
}
