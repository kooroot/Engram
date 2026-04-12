#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config/index.js';
import { createEngramServer } from './server.js';

async function main() {
  const config = loadConfig();
  const engram = createEngramServer(config);

  const transport = new StdioServerTransport();
  await engram.mcpServer.connect(transport);

  // Log startup to stderr (stdout is reserved for MCP protocol)
  console.error(`Engram MCP server running (data: ${config.dataDir})`);

  // M6: Graceful shutdown — close transport then DB
  const shutdown = async () => {
    await engram.mcpServer.close();
    engram.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
