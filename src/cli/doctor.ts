import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { loadConfig } from '../config/index.js';
import { resolveEmbeddingProvider } from '../service.js';

type CheckStatus = 'ok' | 'warn' | 'fail';
interface CheckResult {
  status: CheckStatus;
  label: string;
  detail: string;
  fix?: string;
}

async function checkSqliteBindings(): Promise<CheckResult> {
  try {
    const mod = await import('better-sqlite3');
    const DatabaseCtor = (mod.default ?? mod) as unknown as new (p: string) => { close: () => void };
    const db = new DatabaseCtor(':memory:');
    db.close();
    return { status: 'ok', label: 'sqlite bindings', detail: 'better-sqlite3 native module loaded' };
  } catch (err) {
    const msg = (err as Error).message;
    const isMissingBindings = /Could not locate the bindings file/i.test(msg) || /bindings/i.test(msg);
    return {
      status: 'fail',
      label: 'sqlite bindings',
      detail: isMissingBindings
        ? 'better-sqlite3 native module not compiled (bun skipped install scripts)'
        : `load error: ${msg.slice(0, 120)}`,
      fix: 'Reinstall with scripts enabled: `bun install -g @kooroot/engram@latest --trust` '
        + 'or `npm install -g @kooroot/engram`',
    };
  }
}

async function hasCommand(cmd: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    child.on('exit', code => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function mcpList(): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn('claude', ['mcp', 'list'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', code => resolve(code === 0 ? out : null));
  });
}

function icon(status: CheckStatus): string {
  if (status === 'ok') return chalk.green('✓');
  if (status === 'warn') return chalk.yellow('!');
  return chalk.red('✗');
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function checkNode(): Promise<CheckResult> {
  const [majorStr] = process.versions.node.split('.');
  const major = Number(majorStr);
  if (major >= 20) {
    return { status: 'ok', label: 'node version', detail: `v${process.versions.node} (≥ 20)` };
  }
  return {
    status: 'fail',
    label: 'node version',
    detail: `v${process.versions.node} (need ≥ 20)`,
    fix: 'Upgrade Node.js (nvm install 22).',
  };
}

function checkBuild(): CheckResult {
  const here = fileURLToPath(import.meta.url);
  const dist = path.resolve(path.dirname(here), '..', 'index.js');
  if (fs.existsSync(dist)) {
    return { status: 'ok', label: 'build output', detail: dist };
  }
  return {
    status: 'fail',
    label: 'build output',
    detail: 'dist/index.js missing',
    fix: 'Run `bun run build` in the engram repo.',
  };
}

function checkDataDir(dataDir: string): CheckResult {
  try {
    const stat = fs.statSync(dataDir);
    if (!stat.isDirectory()) {
      return { status: 'fail', label: 'data directory', detail: `${dataDir} exists but is not a directory` };
    }
    try {
      fs.accessSync(dataDir, fs.constants.W_OK);
    } catch {
      return { status: 'fail', label: 'data directory', detail: `${dataDir} not writable`, fix: `chmod u+w ${dataDir}` };
    }
    return { status: 'ok', label: 'data directory', detail: `${dataDir} (writable)` };
  } catch {
    return {
      status: 'warn',
      label: 'data directory',
      detail: `${dataDir} does not exist yet`,
      fix: `mkdir -p ${dataDir}  (or run: engram onboard)`,
    };
  }
}

function checkDbFile(filePath: string, label: string): CheckResult {
  if (!fs.existsSync(filePath)) {
    return {
      status: 'warn',
      label,
      detail: 'not created yet (will initialize on first use)',
    };
  }
  const { size } = fs.statSync(filePath);
  return { status: 'ok', label, detail: `${filePath} (${fmtSize(size)})` };
}

async function checkEmbeddingProvider(): Promise<CheckResult> {
  const config = loadConfig();
  const provider = config.embedding.provider;
  if (provider === 'none') {
    return { status: 'warn', label: 'embedding provider', detail: 'none (semantic search disabled)' };
  }
  try {
    const instance = resolveEmbeddingProvider(config);
    if (!instance) {
      return { status: 'warn', label: 'embedding provider', detail: `${provider} → not instantiated` };
    }
    // Quick liveness probe
    try {
      const vec = await instance.embed('engram ping');
      if (!Array.isArray(vec) || vec.length === 0) throw new Error('empty embedding returned');
      return { status: 'ok', label: 'embedding provider', detail: `${provider} (dim=${vec.length})` };
    } catch (err) {
      return {
        status: 'fail',
        label: 'embedding provider',
        detail: `${provider} — probe failed: ${(err as Error).message.slice(0, 120)}`,
        fix: provider === 'shell'
          ? 'Check ENGRAM_EMBEDDING_CMD produces JSON on stdout.'
          : provider === 'openai'
            ? 'Verify OPENAI_API_KEY is valid.'
            : undefined,
      };
    }
  } catch (err) {
    return {
      status: 'fail',
      label: 'embedding provider',
      detail: `${provider} — config error: ${(err as Error).message}`,
    };
  }
}

async function checkMcpRegistration(): Promise<CheckResult> {
  const hasCli = await hasCommand('claude');
  if (!hasCli) {
    return { status: 'warn', label: 'claude mcp', detail: 'claude CLI not found (skipped)' };
  }
  const list = await mcpList();
  if (list === null) {
    return { status: 'warn', label: 'claude mcp', detail: '`claude mcp list` failed' };
  }
  if (/\bengram\b/.test(list)) {
    return { status: 'ok', label: 'claude mcp', detail: 'engram is registered' };
  }
  return {
    status: 'warn',
    label: 'claude mcp',
    detail: 'engram not registered',
    fix: 'Run: engram onboard',
  };
}

function printRow(r: CheckResult): void {
  console.log(`  ${icon(r.status)} ${r.label.padEnd(22)} ${chalk.dim(r.detail)}`);
  if (r.fix) console.log(`    ${chalk.dim('→')} ${chalk.cyan(r.fix)}`);
}

export async function runDoctor(): Promise<void> {
  console.log(chalk.bold('\nEngram Doctor\n'));

  const config = loadConfig();
  const dataDir = config.dataDir;
  const mainDb = path.join(dataDir, config.dbFilename);
  const vecDb = path.join(dataDir, config.vecDbFilename);

  const results: CheckResult[] = [];
  results.push(await checkNode());
  results.push(checkBuild());
  const bindingsResult = await checkSqliteBindings();
  results.push(bindingsResult);
  results.push(checkDataDir(dataDir));
  results.push(checkDbFile(mainDb, 'main db'));
  results.push(checkDbFile(vecDb, 'vector db'));
  // Skip provider probe if bindings are broken — it would fail for unrelated reasons
  if (bindingsResult.status !== 'fail') {
    results.push(await checkEmbeddingProvider());
  }
  results.push(await checkMcpRegistration());

  results.forEach(printRow);

  const fails = results.filter(r => r.status === 'fail').length;
  const warns = results.filter(r => r.status === 'warn').length;

  console.log('');
  if (fails > 0) {
    console.log(chalk.red(`${fails} fail${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}.`));
    process.exitCode = 1;
  } else if (warns > 0) {
    console.log(chalk.yellow(`${warns} warning${warns === 1 ? '' : 's'}, no failures.`));
  } else {
    console.log(chalk.green('All checks passed.'));
  }
  console.log('');
}
