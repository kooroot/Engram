import React from 'react';
import { render } from 'ink';
import type { EngramCore } from '../service.js';
import { App } from '../tui/index.js';

export async function runTui(core: EngramCore): Promise<void> {
  if (!process.stdout.isTTY) {
    console.error('engram tui requires a TTY. Pipe the regular CLI commands instead (engram usage --plain).');
    process.exit(1);
  }
  const app = render(React.createElement(App, { core }), {
    exitOnCtrlC: false, // App handles ctrl-c
  });
  await app.waitUntilExit();
}
