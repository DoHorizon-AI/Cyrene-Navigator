// Small local DSH MCP stdio fixture; the final argv item points at the package's SDK dependency root.
import { createRequire } from 'node:module';

const require = createRequire(process.argv.at(-1));
const { McpServer } = require('@modelcontextprotocol/server');
const { StdioServerTransport } = require('@modelcontextprotocol/server/stdio');
const { z } = require('zod');
const server = new McpServer({ name: 'navigator-stdio-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.registerTool('echo', {
  description: 'Returns the supplied fixture value.',
  inputSchema: z.object({ value: z.string() }),
}, async ({ value }) => ({ content: [{ type: 'text', text: `stdio:${value}` }] }));
await server.connect(new StdioServerTransport());
