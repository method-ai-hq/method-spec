import { toolContent } from './tool-connections.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fail, safeData } from './validate.js';

// A short-lived, authenticated MCP endpoint forwards declared tools to the runner.
// It has no file access or tool execution path of its own.
export async function startMethodTools(execution, context) {
  const token = randomUUID();
  const names = execution.kind === 'agent' ? (execution.tools ?? []) : [];
  let queue = Promise.resolve();
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(405).end(); return; }
    let message;
    const send = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > context.maxRequestBytes) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      safeData(message);
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      let result;
      if (message.method === 'initialize') result = {
        protocolVersion: '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'method-step-tools', version: '1.0.0' },
      };
      else if (message.method === 'ping') result = {};
      else if (message.method === 'tools/list') result = { tools: names.map(name => {
        const tool = context.toolDefinition(name);
        return { name, description: tool.description, inputSchema: tool.parameters };
      }) };
      else if (message.method === 'tools/call') {
        const { name, arguments: args = {} } = message.params ?? {};
        if (!names.includes(name)) fail(`Tool is not allowed: ${name}`, 'tool_denied');
        // Keep shared artifacts and the run journal in order even if Codex calls in parallel.
        const call = queue.then(() => context.invokeTool(name, args, randomUUID()));
        queue = call.catch(() => {});
        try {
          const value = await call;
          result = toolContent(value);
        } catch (error) {
          result = { isError: true, content: [{ type: 'text', text: error.message }] };
        }
      } else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } }); return; }
      send({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32602, message: error.message } });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`, token,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await queue; },
  };
}

