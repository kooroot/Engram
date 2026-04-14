import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';

interface OnboardAnswers {
  dataDir: string;
  namespace: string;
  provider: 'none' | 'openai' | 'shell' | 'local';
  shellCmd?: string;
  embeddingDimension?: number;
  installClaude: boolean;
}

function expandHome(input: string): string {
  const s = input.trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
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
  return path.resolve(path.dirname(here), '..', '..', 'dist', 'index.js');
}

function quoteShell(s: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
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

async function runClaudeMcpAdd(entry: string, answers: OnboardAnswers): Promise<{ ok: boolean; message: string }> {
  return new Promise(resolve => {
    const args = [
      'mcp', 'add', 'engram',
      '--env', `ENGRAM_DATA_DIR=${answers.dataDir}`,
      '--env', `ENGRAM_NAMESPACE=${answers.namespace}`,
      '--env', `ENGRAM_EMBEDDING_PROVIDER=${answers.provider}`,
    ];
    if (answers.shellCmd) args.push('--env', `ENGRAM_EMBEDDING_CMD=${answers.shellCmd}`);
    if (answers.embeddingDimension) args.push('--env', `ENGRAM_EMBEDDING_DIMENSION=${answers.embeddingDimension}`);
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

function ensureNotCancelled<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
}

export async function runOnboard(): Promise<void> {
  console.clear();
  p.intro('🧠  Engram onboarding');

  const hasCodex = await hasCommand('codex');
  const hasOpenAIKey = !!process.env['OPENAI_API_KEY'];
  const hasClaudeCli = await hasCommand('claude');

  const dataDirInput = await p.text({
    message: 'Data directory',
    placeholder: '~/.engram',
    initialValue: '~/.engram',
    validate: value => {
      if (!value || value.trim().length === 0) return 'Path required';
    },
  });
  ensureNotCancelled(dataDirInput);
  const dataDir = path.resolve(expandHome(dataDirInput as string));

  const namespace = await p.text({
    message: 'Namespace',
    placeholder: 'default',
    initialValue: 'default',
    validate: value => {
      if (!/^[a-zA-Z0-9_\-.]+$/.test(value as string)) {
        return 'Use letters, numbers, dashes, dots, or underscores';
      }
    },
  });
  ensureNotCancelled(namespace);

  const providerChoice = await p.select<'none' | 'codex' | 'openai' | 'shell' | 'local'>({
    message: 'Semantic search provider',
    initialValue: 'none',
    options: [
      { value: 'none', label: 'none', hint: 'graph + FTS only — no external deps (recommended to start)' },
      {
        value: 'codex',
        label: 'subscription: Codex',
        hint: hasCodex ? 'codex CLI detected ✓  — uses OAuth' : 'install `codex` CLI first',
      },
      {
        value: 'openai',
        label: 'api key: OpenAI',
        hint: hasOpenAIKey ? 'OPENAI_API_KEY detected ✓' : 'requires OPENAI_API_KEY env var',
      },
      { value: 'shell', label: 'custom: shell cmd', hint: 'bring your own embedding command' },
      { value: 'local', label: 'local: hash', hint: 'deterministic; low quality, testing only' },
    ],
  });
  ensureNotCancelled(providerChoice);

  let provider: OnboardAnswers['provider'] = 'none';
  let shellCmd: string | undefined;
  let embeddingDimension: number | undefined;

  if (providerChoice === 'codex') {
    if (!hasCodex) {
      p.log.warn('codex CLI not found. Install it first, then run `engram onboard` again.');
      p.outro('Aborted.');
      return;
    }
    const cmd = await p.text({
      message: 'Shell command for codex embedding',
      initialValue: 'codex embed --stdin --json',
    });
    ensureNotCancelled(cmd);
    const dim = await p.text({
      message: 'Embedding dimension',
      initialValue: '1536',
      validate: v => { if (!/^\d+$/.test(v as string)) return 'Must be a positive integer'; },
    });
    ensureNotCancelled(dim);
    provider = 'shell';
    shellCmd = cmd as string;
    embeddingDimension = Number(dim);
  } else if (providerChoice === 'shell') {
    const cmd = await p.text({
      message: 'Shell command (reads text on stdin, outputs JSON embedding)',
      placeholder: 'ollama run nomic-embed-text',
      validate: v => { if (!(v as string)?.trim()) return 'Command required'; },
    });
    ensureNotCancelled(cmd);
    const dim = await p.text({
      message: 'Embedding dimension',
      initialValue: '1536',
      validate: v => { if (!/^\d+$/.test(v as string)) return 'Must be a positive integer'; },
    });
    ensureNotCancelled(dim);
    provider = 'shell';
    shellCmd = cmd as string;
    embeddingDimension = Number(dim);
  } else if (providerChoice === 'openai' || providerChoice === 'local' || providerChoice === 'none') {
    provider = providerChoice;
  }

  let installClaude = false;
  if (hasClaudeCli) {
    const confirmInstall = await p.confirm({
      message: 'Install into Claude Code MCP?',
      initialValue: true,
    });
    ensureNotCancelled(confirmInstall);
    installClaude = confirmInstall as boolean;
  } else {
    p.log.info('claude CLI not found — skipping automatic MCP registration');
  }

  const answers: OnboardAnswers = {
    dataDir,
    namespace: namespace as string,
    provider,
    shellCmd,
    embeddingDimension,
    installClaude,
  };

  const s = p.spinner();

  s.start('Creating data directory');
  fs.mkdirSync(dataDir, { recursive: true });
  s.stop(`Data directory  ${dataDir}`);

  s.start('Writing env file');
  const envPath = writeEnvFile(dataDir, answers);
  s.stop(`Env file        ${envPath}`);

  s.start('Locating engram binary');
  const entry = findEngramEntry();
  if (!fs.existsSync(entry)) {
    s.stop(`Build missing — run \`bun run build\` first`);
  } else {
    s.stop(`Engram binary   ${entry}`);
  }

  if (installClaude) {
    s.start('Registering MCP server with Claude Code');
    const result = await runClaudeMcpAdd(entry, answers);
    if (result.ok) {
      s.stop('Claude MCP      registered');
    } else {
      s.stop(`Claude MCP      failed (${result.message})`);
      printManualMcpInstructions(entry, answers);
    }
  } else if (!hasClaudeCli) {
    printManualMcpInstructions(entry, answers);
  }

  p.note(
    [
      `source ${envPath}`,
      'engram status',
      'engram doctor',
    ].join('\n'),
    'Next steps',
  );

  p.outro('Done.');
}

function printManualMcpInstructions(entry: string, answers: OnboardAnswers): void {
  const envFlags = [
    `--env ENGRAM_DATA_DIR=${answers.dataDir}`,
    `--env ENGRAM_NAMESPACE=${answers.namespace}`,
    `--env ENGRAM_EMBEDDING_PROVIDER=${answers.provider}`,
  ];
  if (answers.shellCmd) envFlags.push(`--env ENGRAM_EMBEDDING_CMD=${quoteShell(answers.shellCmd)}`);
  const lines = ['claude mcp add engram \\', ...envFlags.map(f => `  ${f} \\`), `  -- node ${entry}`];
  p.note(lines.join('\n'), 'Manual MCP install');
}
