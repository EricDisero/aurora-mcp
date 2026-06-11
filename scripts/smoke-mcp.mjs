// MCP stdio smoke test: spawn the server, run initialize → tools/list → one
// real tool call (aurora_list_projects), print results. No paid calls.
import { spawn } from 'node:child_process'

const server = spawn('node', ['packages/mcp/dist/server.js'], { stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
const pending = new Map()
let nextId = 1

server.stdout.on('data', (d) => {
  buf += d.toString()
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    } catch {
      /* partial */
    }
  }
})
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))

function rpc(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout on ${method}`))
      }
    }, 15000)
  })
}

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0.0.0' }
})
console.log(`initialize OK: ${init.result.serverInfo.name} v${init.result.serverInfo.version}`)
server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

const tools = await rpc('tools/list', {})
console.log(`tools/list OK: ${tools.result.tools.length} tools`)
console.log(tools.result.tools.map((t) => t.name).join(', '))

const call = await rpc('tools/call', { name: 'aurora_list_projects', arguments: {} })
console.log(`tools/call aurora_list_projects OK: ${JSON.stringify(call.result.content[0].text).slice(0, 200)}`)

server.kill()
process.exit(0)
