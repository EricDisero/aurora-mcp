import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Operation, OperationResult } from '@ericdisero/aurora-shared'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'

/** JSON Schema preserves nullable inputs as null unions rather than OpenAPI nullable keywords. */
export function operationTool(op: Operation<unknown>): Tool {
  return {
    name: op.id,
    description: op.description,
    annotations: op.annotations,
    inputSchema: zodToJsonSchema(op.input as never, { target: 'jsonSchema7' }) as Tool['inputSchema'],
    outputSchema: { ...zodToJsonSchema(op.outputSchema as never, { target: 'jsonSchema7' }), type: 'object' as const }
  }
}

export function toolResult(result: OperationResult): CallToolResult {
  const structuredContent = JSON.parse(JSON.stringify(result.structuredContent)) as Record<string, unknown>
  return {
    content: [
      { type: 'text' as const, text: result.text },
      { type: 'text' as const, text: JSON.stringify(structuredContent) }
    ],
    structuredContent,
    ...(result.isError ? { isError: true } : {})
  }
}
