import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { renderBanner } from './banner.js';

interface OnboardAnswers {
  dataDir: string;
  namespace: string;
  provider: 'none' | 'openai' | 'shell' | 'local';
  shellCmd?: string;
  embeddingDimension?: number;
  installClaude: boolean;
}

const CLAUDE_MCP_TIMEOUT_MS = 30_000;

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

async function runClaudeMcpAdd(entry: string, answers: OnboardAnswers): Promise<{ ok: boolean; message: string; output: string }> {
  return new Promise(resolve => {
    const args = [
      'mcp', 'add', 'engram',
      '--scope', 'user',   // avoid interactive scope prompt on newer claude CLIs
      '--env', `ENGRAM_DATA_DIR=${answers.dataDir}`,
      '--env', `ENGRAM_NAMESPACE=${answers.namespace}`,
      '--env', `ENGRAM_EMBEDDING_PROVIDER=${answers.provider}`,
    ];
    if (answers.shellCmd) args.push('--env', `ENGRAM_EMBEDDING_CMD=${answers.shellCmd}`);
    if (answers.embeddingDimension) args.push('--env', `ENGRAM_EMBEDDING_DIMENSION=${answers.embeddingDimension}`);
    args.push('--', 'node', entry);

    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, message: `timed out after ${CLAUDE_MCP_TIMEOUT_MS / 1000}s`, output: (stdout + stderr).trim() });
    }, CLAUDE_MCP_TIMEOUT_MS);

    child.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, message: err.message, output: (stdout + stderr).trim() });
    });
    child.on('close', code => {
      clearTimeout(timer);
      const output = (stdout + stderr).trim();
      if (code === 0) resolve({ ok: true, message: 'registered', output });
      else resolve({ ok: false, message: `claude exited ${code}`, output });
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
  process.stdout.write(renderBanner());
  p.intro('🧠  Engram onboarding');

  p.note(
    [
      'This wizard configures:',
      '  • Data directory + namespace',
      '  • Semantic search provider (optional)',
      '  • Claude Code MCP registration (optional)',
      '',
      'Takes ~30 seconds. Press Ctrl+C at any point to cancel.',
    ].join('\n'),
    'What this does',
  );

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
    message: 'Namespace (separates memory pools; use "default" unless you know you want multi-tenant)',
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
    message: 'Semantic search provider  (can be changed later by editing engram.env)',
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
      message: 'Install into Claude Code MCP?  (runs `claude mcp add engram --scope user ...`)',
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

  // ─── Review ──────────────────────────────────────────
  p.note(
    [
      `Data dir:     ${dataDir}`,
      `Namespace:    ${namespace}`,
      `Provider:     ${provider}${shellCmd ? `  (cmd: ${shellCmd})` : ''}`,
      `Claude MCP:   ${installClaude ? 'yes (scope=user)' : 'no'}`,
    ].join('\n'),
    'Review — about to apply',
  );

  // ─── Fast, instant operations — use p.log so output is always visible ───
  fs.mkdirSync(dataDir, { recursive: true });
  p.log.success(`Data directory ready  ${dataDir}`);

  const envPath = writeEnvFile(dataDir, answers);
  p.log.success(`Env file written      ${envPath}`);

  const entry = findEngramEntry();
  if (!fs.existsSync(entry)) {
    p.log.warn(`Engram binary not found at ${entry} — if you installed from source, run \`bun run build\``);
  } else {
    p.log.info(`Engram binary         ${entry}`);
  }

  // ─── Slow operation: claude mcp add (with spinner + timeout) ─────────────
  if (installClaude) {
    const s = p.spinner();
    s.start('Registering Engram with Claude Code  (up to 30s)');
    const result = await runClaudeMcpAdd(entry, answers);
    if (result.ok) {
      s.stop('Claude Code MCP registered ✓');
      if (result.output) p.log.info(result.output);
    } else {
      s.stop(`Claude Code MCP registration failed — ${result.message}`);
      if (result.output) p.log.error(result.output);
      printManualMcpInstructions(entry, answers);
    }
  } else if (!hasClaudeCli) {
    printManualMcpInstructions(entry, answers);
  }

  // ─── Rich next steps ─────────────────────────────────────────────────────
  p.note(
    [
      '1. Activate env in your shell:',
      `     source ${envPath}`,
      '',
      '2. Verify the install:',
      '     engram doctor',
      '',
      '3. See your memory graph stats:',
      '     engram status',
      '',
      ...(installClaude
        ? [
          '4. Open Claude Code and run /mcp — `engram` should appear in the list.',
          '   Try: "remember that I prefer TypeScript"',
          '        then later: "what languages do I prefer?"',
          '',
        ]
        : [
          '4. Register Engram with your MCP client (see Manual MCP install above).',
          '',
        ]),
      `Edit ${envPath} later to change provider, namespace, or other settings.`,
      'Learn more: https://github.com/kooroot/Engram#readme',
    ].join('\n'),
    'Next steps',
  );

  p.outro('Setup complete.');
}

function printManualMcpInstructions(entry: string, answers: OnboardAnswers): void {
  const envFlags = [
    `--env ENGRAM_DATA_DIR=${answers.dataDir}`,
    `--env ENGRAM_NAMESPACE=${answers.namespace}`,
    `--env ENGRAM_EMBEDDING_PROVIDER=${answers.provider}`,
  ];
  if (answers.shellCmd) envFlags.push(`--env ENGRAM_EMBEDDING_CMD=${quoteShell(answers.shellCmd)}`);
  if (answers.embeddingDimension) envFlags.push(`--env ENGRAM_EMBEDDING_DIMENSION=${answers.embeddingDimension}`);
  const lines = [
    'claude mcp add engram --scope user \\',
    ...envFlags.map(f => `  ${f} \\`),
    `  -- node ${entry}`,
  ];
  p.note(lines.join('\n'), 'Manual MCP install');
}
