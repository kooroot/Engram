#!/usr/bin/env node

import { Command } from 'commander';

const program = new Command('engram')
  .version('0.1.0')
  .description('AI-native persistent memory system');

// Detect if we should start MCP server (piped stdin from MCP client)
// or run CLI commands (interactive terminal)
const isMcpMode = !process.stdin.isTTY && process.argv.length <= 2;

if (isMcpMode) {
  // MCP server mode — backward compatible with existing MCP client configs
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
} else {
  // CLI mode
  const { registerCLICommands } = await import('./cli/index.js');
  registerCLICommands(program);

  // `engram serve` for REST API (registered in cli/index.ts in Phase 4)

  // `engram mcp` as explicit MCP server start
  program
    .command('mcp')
    .description('Start MCP server on stdio (for MCP client configs)')
    .action(async () => {
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
    });

  program.parse();
}
