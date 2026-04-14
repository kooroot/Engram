import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import chalk from 'chalk';

interface Choice {
  id: string;
  label: string;
  note?: string;
  disabled?: string;
}

interface OnboardAnswers {
  dataDir: string;
  namespace: string;
  provider: 'none' | 'openai' | 'shell' | 'local';
  shellCmd?: string;
  embeddingDimension?: number;
  installClaude: boolean;
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function colorize(s: string, c: 'cyan' | 'green' | 'gray' | 'yellow' | 'red' | 'dim'): string {
  if (c === 'dim') return chalk.dim(s);
  return chalk[c](s);
}

async function hasCommand(cmd: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    child.on('exit', code => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function findEngramEntry(): string {
  const here = fileURLToPath(import.meta.url);
  const distIndex = path.resolve(path.dirname(here), '..', 'index.js');
  if (fs.existsSync(distIndex)) return distIndex;
  const srcIndex = path.resolve(path.dirname(here), '..', '..', 'dist', 'index.js');
  return srcIndex;
}

async function prompt(rl: readline.Interface, question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? colorize(` (${defaultVal})`, 'dim') : '';
  const answer = (await rl.question(`${chalk.cyan('?')} ${question}${suffix} › `)).trim();
  return answer || defaultVal || '';
}

async function selectFromList(
  rl: readline.Interface,
  question: string,
  choices: Choice[],
  defaultIdx: number,
): Promise<Choice> {
  console.log(`${chalk.cyan('?')} ${question}`);
  choices.forEach((c, i) => {
    const pointer = i === defaultIdx ? chalk.green('❯') : ' ';
    const label = c.disabled ? chalk.dim(`${c.label} — ${c.disabled}`) : c.label;
    const note = c.note ? chalk.dim(`  ${c.note}`) : '';
    console.log(`  ${pointer} ${i + 1}) ${label}${note}`);
  });
  while (true) {
    const raw = (await rl.question(`  Choice [${defaultIdx + 1}] › `)).trim();
    const idx = raw === '' ? defaultIdx : Number(raw) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < choices.length && !choices[idx].disabled) {
      return choices[idx];
    }
    console.log(chalk.yellow('  Invalid choice. Try again.'));
  }
}

async function confirm(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const raw = (await rl.question(`${chalk.cyan('?')} ${question} (${hint}) › `)).trim().toLowerCase();
  if (!raw) return defaultYes;
  return raw === 'y' || raw === 'yes';
}

async function askProvider(rl: readline.Interface): Promise<{
  provider: OnboardAnswers['provider'];
  shellCmd?: string;
  embeddingDimension?: number;
}> {
  const hasCodex = await hasCommand('codex');
  const hasOpenAIKey = !!process.env['OPENAI_API_KEY'];
  const hasClaude = await hasCommand('claude');  // referenced for diagnostics only

  const choices: Choice[] = [
    { id: 'none', label: 'none', note: 'graph + FTS only; no external deps (recommended to start)' },
    {
      id: 'codex',
      label: 'subscription: Codex',
      note: hasCodex ? 'detected ✓  — uses `codex` CLI via OAuth' : 'install `codex` CLI first',
      disabled: hasCodex ? undefined : 'codex not found in PATH',
    },
    {
      id: 'openai',
      label: 'api key: OpenAI',
      note: hasOpenAIKey ? 'OPENAI_API_KEY detected ✓' : 'requires OPENAI_API_KEY env var',
    },
    { id: 'shell', label: 'custom: shell cmd', note: 'bring your own embedding command' },
    { id: 'local', label: 'local: hash', note: 'deterministic; low quality, testing only' },
  ];

  // Suppress unused — kept for future doctor integration
  void hasClaude;

  const picked = await selectFromList(rl, 'Semantic search provider:', choices, 0);

  if (picked.id === 'codex') {
    const defaultCmd = 'codex embed --stdin --json';
    const cmd = await prompt(rl, 'Shell command for codex embedding', defaultCmd);
    const dim = await prompt(rl, 'Embedding dimension', '1536');
    return { provider: 'shell', shellCmd: cmd, embeddingDimension: Number(dim) || 1536 };
  }
  if (picked.id === 'shell') {
    const cmd = await prompt(rl, 'Shell command (reads text on stdin, outputs JSON embedding)');
    const dim = await prompt(rl, 'Embedding dimension', '1536');
    return { provider: 'shell', shellCmd: cmd, embeddingDimension: Number(dim) || 1536 };
  }
  return { provider: picked.id as OnboardAnswers['provider'] };
}

function writeEnvFile(dataDir: string, answers: OnboardAnswers): string {
  const lines = [
    '# Engram config — source this file or set env vars',
    `export ENGRAM_DATA_DIR=${quoteShell(dataDir)}`,
    `export ENGRAM_NAMESPACE=${quoteShell(answers.namespace)}`,
    `export ENGRAM_EMBEDDING_PROVIDER=${quoteShell(answers.provider)}`,
  ];
  if (answers.shellCmd) lines.push(`export ENGRAM_EMBEDDING_CMD=${quoteShell(answers.shellCmd)}`);
  if (answers.embeddingDimension) lines.push(`export ENGRAM_EMBEDDING_DIMENSION=${answers.embeddingDimension}`);
  const envPath = path.join(dataDir, 'engram.env');
  fs.writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
  return envPath;
}

function quoteShell(s: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function runClaudeMcpAdd(entry: string, answers: OnboardAnswers): Promise<{ ok: boolean; message: string }> {
  return new Promise(resolve => {
    const args = [
      'mcp', 'add', 'engram',
      '--env', `ENGRAM_DATA_DIR=${answers.dataDir}`,
      '--env', `ENGRAM_NAMESPACE=${answers.namespace}`,
      '--env', `ENGRAM_EMBEDDING_PROVIDER=${answers.provider}`,
    ];
    if (answers.shellCmd) {
      args.push('--env', `ENGRAM_EMBEDDING_CMD=${answers.shellCmd}`);
    }
    if (answers.embeddingDimension) {
      args.push('--env', `ENGRAM_EMBEDDING_DIMENSION=${answers.embeddingDimension}`);
    }
    args.push('--', 'node', entry);

    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => resolve({ ok: false, message: err.message }));
    child.on('close', code => {
      if (code === 0) resolve({ ok: true, message: 'registered' });
      else resolve({ ok: false, message: stderr.slice(0, 240) || `claude exited ${code}` });
    });
  });
}

export async function runOnboard(): Promise<void> {
  console.log(chalk.bold('\n🧠 Engram onboarding\n'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const dataDirRaw = await prompt(rl, 'Data directory', '~/.engram');
    const dataDir = path.resolve(expandHome(dataDirRaw));
    const namespace = await prompt(rl, 'Namespace', 'default');
    const { provider, shellCmd, embeddingDimension } = await askProvider(rl);

    const hasClaudeCli = await hasCommand('claude');
    const installClaude = hasClaudeCli
      ? await confirm(rl, 'Install into Claude Code MCP?', true)
      : false;

    const answers: OnboardAnswers = {
      dataDir,
      namespace,
      provider,
      shellCmd,
      embeddingDimension,
      installClaude,
    };

    console.log('');

    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`${colorize('✓', 'green')} data directory  ${dataDir}`);

    const envPath = writeEnvFile(dataDir, answers);
    console.log(`${colorize('✓', 'green')} env file        ${envPath}`);

    const entry = findEngramEntry();
    if (!fs.existsSync(entry)) {
      console.log(`${colorize('!', 'yellow')} build output not found at ${entry} — run \`bun run build\` first`);
    } else {
      console.log(`${colorize('✓', 'green')} engram binary   ${entry}`);
    }

    if (installClaude) {
      const result = await runClaudeMcpAdd(entry, answers);
      if (result.ok) {
        console.log(`${colorize('✓', 'green')} claude mcp      registered`);
      } else {
        console.log(`${colorize('!', 'yellow')} claude mcp add failed — ${result.message}`);
        printManualMcpInstructions(entry, answers);
      }
    } else if (!hasClaudeCli) {
      console.log(`${colorize('-', 'dim')} claude cli not found (skipped MCP install)`);
      printManualMcpInstructions(entry, answers);
    }

    console.log('');
    console.log(chalk.bold('Done.') + ' Try:');
    console.log(`  ${chalk.cyan('source')} ${envPath}`);
    console.log(`  ${chalk.cyan('engram')} status`);
    console.log(`  ${chalk.cyan('engram')} doctor`);
    console.log('');
  } finally {
    rl.close();
  }
}

function printManualMcpInstructions(entry: string, answers: OnboardAnswers): void {
  console.log('');
  console.log(chalk.dim('  Manual MCP install:'));
  const envFlags = [
    `--env ENGRAM_DATA_DIR=${answers.dataDir}`,
    `--env ENGRAM_NAMESPACE=${answers.namespace}`,
    `--env ENGRAM_EMBEDDING_PROVIDER=${answers.provider}`,
  ];
  if (answers.shellCmd) envFlags.push(`--env ENGRAM_EMBEDDING_CMD=${quoteShell(answers.shellCmd)}`);
  console.log(chalk.dim(`  claude mcp add engram \\`));
  envFlags.forEach(f => console.log(chalk.dim(`    ${f} \\`)));
  console.log(chalk.dim(`    -- node ${entry}`));
}
