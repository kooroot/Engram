import { createRequire } from 'node:module';
import chalk from 'chalk';

const LINES = [
  ' ███████╗███╗   ██╗ ██████╗ ██████╗  █████╗ ███╗   ███╗',
  ' ██╔════╝████╗  ██║██╔════╝ ██╔══██╗██╔══██╗████╗ ████║',
  ' █████╗  ██╔██╗ ██║██║  ███╗██████╔╝███████║██╔████╔██║',
  ' ██╔══╝  ██║╚██╗██║██║   ██║██╔══██╗██╔══██║██║╚██╔╝██║',
  ' ███████╗██║ ╚████║╚██████╔╝██║  ██║██║  ██║██║ ╚═╝ ██║',
  ' ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝',
];

// Rainbow gradient row-by-row
const ROW_COLORS = [
  chalk.hex('#ff5e5b'),
  chalk.hex('#ff964f'),
  chalk.hex('#ffd166'),
  chalk.hex('#7ae582'),
  chalk.hex('#5bc0eb'),
  chalk.hex('#b56cff'),
];

function getVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '';
  }
}

export function renderBanner(): string {
  const colored = LINES.map((line, i) => (ROW_COLORS[i] ?? chalk.white)(line));
  const version = getVersion();
  const tagline = chalk.dim('  AI-native persistent memory for agents');
  const meta = chalk.dim(`  ${version ? `v${version}  •  ` : ''}github.com/kooroot/Engram`);
  return ['', ...colored, '', tagline, meta, ''].join('\n');
}

export function printBanner(): void {
  process.stdout.write(renderBanner() + '\n');
}
