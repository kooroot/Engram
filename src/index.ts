#!/usr/bin/env node

import { createRequire } from 'node:module';
import { Command } from 'commander';

// L5: Read version from package.json instead of hardcoding
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const program = new Command('engram')
  .version(pkg.version)
  .description('AI-native persistent memory system');

// H3: Shared MCP startup function — single source of truth
async function startMcpServer() {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { loadConfig } = await import('./config/index.js');
  const { createEngramServer } = await import('./server.js');

  const config = loadConfig();
  const engram = createEngramServer(config);
  const transport = new StdioServerTransport();
  await engram.mcpServer.connect(transport);

  console.error(`Engram MCP server running (data: ${config.dataDir})`);

  const shutdown = async () => {
    await engram.mcpServer.close();
    engram.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Detect: piped stdin with no args → MCP server, otherwise CLI
const isMcpMode = !process.stdin.isTTY && process.argv.length <= 2;

if (isMcpMode) {
  startMcpServer();
} else {
  const { registerCLICommands } = await import('./cli/index.js');
  registerCLICommands(program);

  program
    .command('mcp')
    .description('Start MCP server on stdio (for MCP client configs)')
    .action(startMcpServer);

  program.parse();
}
