// Deterministic stdio fixture; never contacts external services.
const readline = require('node:readline');
const reply = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let clientCapabilities;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    clientCapabilities = request.params.capabilities;
    return reply({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'scheduler-fixture', version: '1' } } });
  }
  if (!Object.hasOwn(request, 'id')) return;
  const params = request.params || {};
  if (params.crash) return process.exit(7);
  if (params.callback) return reply({ jsonrpc: '2.0', id: 'callback', method: 'sampling/createMessage', params: {} });
  const child = params.spawnChild ? require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }) : null;
  if (params._meta?.progressToken !== undefined) reply({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: params._meta.progressToken, progress: 1 } });
  setTimeout(() => reply({ jsonrpc: '2.0', id: request.id, result: { content: [], tools: [], clientCapabilities, pid: process.pid, child: child?.pid, cwd: process.cwd(), marker: process.env.CODEY_MCP_MARKER, resident: process.memoryUsage().rss } }), params.delay || 0);
}).on('close', () => process.exit(0));
