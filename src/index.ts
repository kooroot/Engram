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

  // Graceful shutdown
  process.on('SIGINT', () => {
    engram.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    engram.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
