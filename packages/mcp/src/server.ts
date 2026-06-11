#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_OPERATIONS, type Operation } from '@ericdisero/aurora-shared'

// Aurora MCP server. Stdio transport. Wires every operation in
// @ericdisero/aurora-shared as an MCP tool. Standalone — works against
// Aurora's userData DB + project folders directly; no running app required.
// Provider keys come from env (MCP config "env" block) or ~/.aurora/config.json
// (written by `aurora keys set`).
//
//   { "command": "npx", "args": ["-y", "@ericdisero/aurora-mcp-server"],
//     "env": { "SUNO_API_KEY": "...", "MVSEP_API_KEY": "..." } }

const ops = ALL_OPERATIONS as readonly Operation<unknown>[]
const opsById = new Map<string, Operation<unknown>>(ops.map((o) => [o.id, o]))

// Version comes from this package's own package.json (dist/server.js →
// ../package.json) so the reported version never drifts from the publish.
const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
) as { version: string }

const server = new Server({ name: 'aurora-audio', version: pkg.version }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ops.map((op) => ({
    name: op.id,
    description: op.description,
    inputSchema: zodToJsonSchema(op.input as never, { target: 'openApi3' }) as Record<string, unknown>
  }))
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const op = opsById.get(request.params.name)
  if (!op) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
      isError: true
    }
  }
  try {
    const args = op.input.parse(request.params.arguments ?? {})
    const result = await op.run(args)
    return { content: [{ type: 'text', text: result.text }] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true
    }
  }
})

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[aurora-mcp] server started, ${ops.length} tools registered`)
}

main().catch((err) => {
  console.error('[aurora-mcp] fatal:', err)
  process.exit(1)
})
