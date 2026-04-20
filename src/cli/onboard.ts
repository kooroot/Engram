import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { renderBanner } from './banner.js';
import {
  getInstructionFiles,
  installInstructions,
  type ClientId as InstructionClientId,
  type InstructionFile,
} from './agent-instructions.js';

type McpClientId = 'claude' | 'codex' | 'gemini';

interface McpClient {
  id: McpClientId;
  binary: string;
  label: string;
}

const MCP_CLIENTS: readonly McpClient[] = [
  { id: 'claude', binary: 'claude', label: 'Claude Code' },
  { id: 'codex',  binary: 'codex',  label: 'Codex CLI' },
  { id: 'gemini', binary: 'gemini', label: 'Gemini CLI' },
] as const;

interface OnboardAnswers {
  dataDir: string;
  namespace: string;
  provider: 'none' | 'openai' | 'shell' | 'ollama' | 'local';
  shellCmd?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
  embeddingDimension?: number;
  installClients: McpClientId[];
}

const MCP_ADD_TIMEOUT_MS = 30_000;
const PROVIDER_TEST_TIMEOUT_MS = 15_000;

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

async function checkUrl(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
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

const ENGRAM_MANAGED_VARS = [
  'ENGRAM_DATA_DIR',
  'ENGRAM_NAMESPACE',
  'ENGRAM_EMBEDDING_PROVIDER',
  'ENGRAM_EMBEDDING_CMD',
  'ENGRAM_EMBEDDING_DIMENSION',
  'ENGRAM_EMBEDDING_TIMEOUT_MS',
  'OLLAMA_URL',
  'OLLAMA_MODEL',
] as const;

function expectedFileEnv(answers: OnboardAnswers): Record<string, string> {
  const out: Record<string, string> = {
    ENGRAM_DATA_DIR: answers.dataDir,
    ENGRAM_NAMESPACE: answers.namespace,
    ENGRAM_EMBEDDING_PROVIDER: answers.provider,
  };
  if (answers.shellCmd) out['ENGRAM_EMBEDDING_CMD'] = answers.shellCmd;
  if (answers.ollamaUrl) out['OLLAMA_URL'] = answers.ollamaUrl;
  if (answers.ollamaModel) out['OLLAMA_MODEL'] = answers.ollamaModel;
  if (answers.embeddingDimension) out['ENGRAM_EMBEDDING_DIMENSION'] = String(answers.embeddingDimension);
  return out;
}

interface ShellConflict {
  key: string;
  shellValue: string;
  fileValue: string | undefined;
}

function detectShellConflicts(answers: OnboardAnswers): ShellConflict[] {
  const file = expectedFileEnv(answers);
  const conflicts: ShellConflict[] = [];
  for (const key of ENGRAM_MANAGED_VARS) {
    const shellValue = process.env[key];
    if (shellValue === undefined) continue;
    const fileValue = file[key];
    if (fileValue !== shellValue) {
      conflicts.push({ key, shellValue, fileValue });
    }
  }
  return conflicts;
}

function listStaleShellVars(): string[] {
  return ENGRAM_MANAGED_VARS.filter(k => process.env[k] !== undefined);
}

function writeEnvFile(dataDir: string, answers: OnboardAnswers): string {
  const lines = [
    '# Engram config — source this file or set env vars',
    `export ENGRAM_DATA_DIR=${quoteShell(dataDir)}`,
    `export ENGRAM_NAMESPACE=${quoteShell(answers.namespace)}`,
    `export ENGRAM_EMBEDDING_PROVIDER=${quoteShell(answers.provider)}`,
  ];
  if (answers.shellCmd) lines.push(`export ENGRAM_EMBEDDING_CMD=${quoteShell(answers.shellCmd)}`);
  if (answers.ollamaUrl) lines.push(`export OLLAMA_URL=${quoteShell(answers.ollamaUrl)}`);
  if (answers.ollamaModel) lines.push(`export OLLAMA_MODEL=${quoteShell(answers.ollamaModel)}`);
  if (answers.embeddingDimension) lines.push(`export ENGRAM_EMBEDDING_DIMENSION=${answers.embeddingDimension}`);
  const envPath = path.join(dataDir, 'engram.env');
  fs.writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
  return envPath;
}

function collectEnvPairs(answers: OnboardAnswers): Array<[string, string]> {
  const pairs: Array<[string, string]> = [
    ['ENGRAM_DATA_DIR', answers.dataDir],
    ['ENGRAM_NAMESPACE', answers.namespace],
    ['ENGRAM_EMBEDDING_PROVIDER', answers.provider],
  ];
  if (answers.shellCmd) pairs.push(['ENGRAM_EMBEDDING_CMD', answers.shellCmd]);
  if (answers.ollamaUrl) pairs.push(['OLLAMA_URL', answers.ollamaUrl]);
  if (answers.ollamaModel) pairs.push(['OLLAMA_MODEL', answers.ollamaModel]);
  if (answers.embeddingDimension) pairs.push(['ENGRAM_EMBEDDING_DIMENSION', String(answers.embeddingDimension)]);
  return pairs;
}

/**
 * Build the per-client `mcp add` argv. Each CLI has slightly different syntax:
 *   - claude:  claude mcp add <name> --scope user --env K=V -- <cmd> [args...]
 *   - codex:   codex  mcp add <name> --env K=V -- <cmd> [args...]
 *   - gemini:  gemini mcp add -s user -e K=V <name> <cmd> [args...]   (no `--`, name/cmd are positional)
 */
function buildMcpAddArgs(client: McpClient, entry: string, answers: OnboardAnswers): string[] {
  const envPairs = collectEnvPairs(answers);
  switch (client.id) {
    case 'claude': {
      const args = ['mcp', 'add', 'engram', '--scope', 'user'];
      for (const [k, v] of envPairs) args.push('--env', `${k}=${v}`);
      args.push('--', 'node', entry);
      return args;
    }
    case 'codex': {
      const args = ['mcp', 'add', 'engram'];
      for (const [k, v] of envPairs) args.push('--env', `${k}=${v}`);
      args.push('--', 'node', entry);
      return args;
    }
    case 'gemini': {
      // Gemini: options first, then positionals (name, command, ...args)
      const args = ['mcp', 'add', '-s', 'user'];
      for (const [k, v] of envPairs) args.push('-e', `${k}=${v}`);
      args.push('engram', 'node', entry);
      return args;
    }
  }
}

async function runMcpAdd(client: McpClient, entry: string, answers: OnboardAnswers): Promise<{ ok: boolean; message: string; output: string }> {
  return new Promise(resolve => {
    const args = buildMcpAddArgs(client, entry, answers);
    const child = spawn(client.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, message: `timed out after ${MCP_ADD_TIMEOUT_MS / 1000}s`, output: (stdout + stderr).trim() });
    }, MCP_ADD_TIMEOUT_MS);

    child.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, message: err.message, output: (stdout + stderr).trim() });
    });
    child.on('close', code => {
      clearTimeout(timer);
      const output = (stdout + stderr).trim();
      if (code === 0) resolve({ ok: true, message: 'registered', output });
      else resolve({ ok: false, message: `${client.binary} exited ${code}`, output });
    });
  });
}

/**
 * Live-test the chosen embedding provider in a child process so the parent's
 * import cache and config singletons aren't touched.
 */
async function testProvider(answers: OnboardAnswers): Promise<{ ok: boolean; message: string }> {
  if (answers.provider === 'none') return { ok: true, message: 'skipped (provider=none)' };

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ENGRAM_DATA_DIR: answers.dataDir,
    ENGRAM_NAMESPACE: answers.namespace,
    ENGRAM_EMBEDDING_PROVIDER: answers.provider,
  };
  if (answers.shellCmd) env['ENGRAM_EMBEDDING_CMD'] = answers.shellCmd;
  if (answers.ollamaUrl) env['OLLAMA_URL'] = answers.ollamaUrl;
  if (answers.ollamaModel) env['OLLAMA_MODEL'] = answers.ollamaModel;
  if (answers.embeddingDimension) env['ENGRAM_EMBEDDING_DIMENSION'] = String(answers.embeddingDimension);

  const here = fileURLToPath(import.meta.url);
  const servicePath = path.resolve(path.dirname(here), '..', 'service.js');
  const configPath = path.resolve(path.dirname(here), '..', 'config', 'index.js');

  // Use a child Node process so dynamic imports happen with the new env.
  return new Promise(resolve => {
    const script = `
import('${configPath.replace(/\\/g, '\\\\')}').then(async cfg => {
  const svc = await import('${servicePath.replace(/\\/g, '\\\\')}');
  try {
    const config = cfg.loadConfig();
    const prov = svc.resolveEmbeddingProvider(config);
    if (!prov) { console.error('no provider instantiated'); process.exit(2); }
    const vec = await prov.embed('engram onboard test');
    if (!Array.isArray(vec) || vec.length === 0) { console.error('empty embedding'); process.exit(3); }
    process.stdout.write('dim=' + vec.length);
    process.exit(0);
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  }
});
    `.trim();

    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, message: `timed out after ${PROVIDER_TEST_TIMEOUT_MS / 1000}s` });
    }, PROVIDER_TEST_TIMEOUT_MS);

    child.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, message: err.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, message: stdout.trim() || 'OK' });
      else resolve({ ok: false, message: stderr.trim().slice(0, 400) || `exit ${code}` });
    });
  });
}

function ensureNotCancelled<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
}

type ProviderId = 'none' | 'openai' | 'ollama' | 'shell' | 'local';

interface ProviderResult {
  provider: OnboardAnswers['provider'];
  shellCmd?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
  embeddingDimension?: number;
}

async function pickProvider(env: { hasOpenAIKey: boolean; ollamaReachable: boolean }): Promise<ProviderResult> {
  while (true) {
    const choice = await p.select<ProviderId>({
      message: 'Semantic search provider  (skip with "none" — you can change later)',
      initialValue: 'none',
      options: [
        { value: 'none', label: 'none', hint: 'graph + FTS only — works without any external service' },
        {
          value: 'ollama',
          label: 'Ollama (local, free)',
          hint: env.ollamaReachable
            ? 'detected at http://localhost:11434 ✓'
            : 'requires `ollama serve` and `ollama pull nomic-embed-text`',
        },
        {
          value: 'openai',
          label: 'OpenAI API key',
          hint: env.hasOpenAIKey ? 'OPENAI_API_KEY detected ✓' : 'requires OPENAI_API_KEY env var',
        },
        { value: 'shell', label: 'custom: shell cmd', hint: 'bring your own embedding command (advanced)' },
        { value: 'local', label: 'local: hash', hint: 'deterministic; low quality, testing only' },
      ],
    });
    ensureNotCancelled(choice);

    if (choice === 'none' || choice === 'local') {
      return { provider: choice };
    }

    if (choice === 'openai') {
      if (!env.hasOpenAIKey) {
        p.log.warn('OPENAI_API_KEY is not set in this shell. Set it and re-run, or pick another provider.');
        continue;
      }
      return { provider: 'openai' };
    }

    if (choice === 'ollama') {
      const url = await p.text({
        message: 'Ollama URL',
        initialValue: 'http://localhost:11434',
        validate: v => { if (!/^https?:\/\//.test(v as string)) return 'Must start with http:// or https://'; },
      });
      ensureNotCancelled(url);
      const model = await p.text({
        message: 'Ollama embedding model  (e.g. nomic-embed-text=768, mxbai-embed-large=1024)',
        initialValue: 'nomic-embed-text',
        validate: v => { if (!(v as string)?.trim()) return 'Model name required'; },
      });
      ensureNotCancelled(model);
      const dim = await p.text({
        message: 'Embedding dimension  (must match the model)',
        initialValue: '768',
        validate: v => { if (!/^\d+$/.test(v as string)) return 'Must be a positive integer'; },
      });
      ensureNotCancelled(dim);
      return {
        provider: 'ollama',
        ollamaUrl: url as string,
        ollamaModel: model as string,
        embeddingDimension: Number(dim),
      };
    }

    // shell
    const cmd = await p.text({
      message: 'Shell command  (reads text on stdin, outputs JSON embedding on stdout)',
      placeholder: 'curl -sS http://localhost:8080/embed -d @-',
      validate: v => { if (!(v as string)?.trim()) return 'Command required'; },
    });
    ensureNotCancelled(cmd);
    const dim = await p.text({
      message: 'Embedding dimension',
      initialValue: '1536',
      validate: v => { if (!/^\d+$/.test(v as string)) return 'Must be a positive integer'; },
    });
    ensureNotCancelled(dim);
    return {
      provider: 'shell',
      shellCmd: cmd as string,
      embeddingDimension: Number(dim),
    };
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
      '  • Semantic search provider (optional, live-tested)',
      '  • Claude Code MCP registration (optional)',
      '',
      'Takes ~30 seconds. Press Ctrl+C at any point to cancel.',
    ].join('\n'),
    'What this does',
  );

  const hasOpenAIKey = !!process.env['OPENAI_API_KEY'];
  const ollamaReachable = await checkUrl('http://localhost:11434');

  // Detect which MCP-supporting CLIs are installed.
  const detectedClients: McpClient[] = [];
  for (const c of MCP_CLIENTS) {
    if (await hasCommand(c.binary)) detectedClients.push(c);
  }

  // Pre-flight: warn if shell already has Engram-managed vars.
  // They will override anything we save here unless the user clears them.
  const preExistingVars = listStaleShellVars();
  if (preExistingVars.length > 0) {
    p.log.warn(
      `Your shell already has these Engram-managed env vars set:\n  ` +
      preExistingVars.map(k => `${k}=${process.env[k]}`).join('\n  ') +
      `\nPrecedence is shell > file, so these will OVERRIDE whatever you choose below.\n` +
      `If you want a fresh setup to take effect, plan to unset them after onboarding.`,
    );
  }

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

  // Loop: pick provider → live-test → on failure offer to re-pick or save anyway
  let providerResult: ProviderResult;
  while (true) {
    providerResult = await pickProvider({ hasOpenAIKey, ollamaReachable });

    const tentative: OnboardAnswers = {
      dataDir,
      namespace: namespace as string,
      provider: providerResult.provider,
      shellCmd: providerResult.shellCmd,
      ollamaUrl: providerResult.ollamaUrl,
      ollamaModel: providerResult.ollamaModel,
      embeddingDimension: providerResult.embeddingDimension,
      installClients: [],
    };

    if (providerResult.provider === 'none') break;

    const s = p.spinner();
    s.start(`Testing ${providerResult.provider} provider with a sample embedding…`);
    const result = await testProvider(tentative);
    if (result.ok) {
      s.stop(`Provider OK  (${result.message})`);
      break;
    }
    s.stop(`Provider test failed: ${result.message}`);

    const action = await p.select<'retry' | 'save' | 'none'>({
      message: 'How would you like to proceed?',
      initialValue: 'retry',
      options: [
        { value: 'retry', label: 'Pick a different provider' },
        { value: 'none', label: 'Skip semantic search (provider=none)' },
        { value: 'save', label: 'Save this config anyway (you can fix it later in engram.env)' },
      ],
    });
    ensureNotCancelled(action);
    if (action === 'save') break;
    if (action === 'none') {
      providerResult = { provider: 'none' };
      break;
    }
    // retry → loop continues
  }

  let installClients: McpClientId[] = [];
  if (detectedClients.length === 0) {
    p.log.info('No MCP-capable CLIs detected (claude/codex/gemini) — skipping automatic registration');
  } else {
    const selected = await p.multiselect<McpClientId>({
      message: `Register Engram with which MCP clients?  (space to toggle, enter to confirm)`,
      initialValues: detectedClients.map(c => c.id),
      required: false,
      options: detectedClients.map(c => ({
        value: c.id,
        label: c.label,
        hint: `${c.binary} mcp add engram …`,
      })),
    });
    ensureNotCancelled(selected);
    installClients = selected as McpClientId[];
  }

  const answers: OnboardAnswers = {
    dataDir,
    namespace: namespace as string,
    provider: providerResult.provider,
    shellCmd: providerResult.shellCmd,
    ollamaUrl: providerResult.ollamaUrl,
    ollamaModel: providerResult.ollamaModel,
    embeddingDimension: providerResult.embeddingDimension,
    installClients,
  };

  const clientsLabel = installClients.length === 0
    ? 'none'
    : installClients
        .map(id => MCP_CLIENTS.find(c => c.id === id)?.label ?? id)
        .join(', ');

  p.note(
    [
      `Data dir:     ${dataDir}`,
      `Namespace:    ${namespace}`,
      `Provider:     ${providerResult.provider}` + providerSummary(providerResult),
      `MCP clients:  ${clientsLabel}`,
    ].join('\n'),
    'Review — about to apply',
  );

  fs.mkdirSync(dataDir, { recursive: true });
  p.log.success(`Data directory ready  ${dataDir}`);

  const envPath = writeEnvFile(dataDir, answers);
  p.log.success(`Env file written      ${envPath}`);

  // Post-write conflict check — surface the stale-shell-vars footgun loudly.
  const conflicts = detectShellConflicts(answers);
  if (conflicts.length > 0) {
    const lines = [
      `${conflicts.length} env var${conflicts.length === 1 ? '' : 's'} in your shell will override the file:`,
      ...conflicts.map(c => `  ${c.key}=${c.shellValue}    (file: ${c.fileValue ?? '(unset)'})`),
      '',
      'Run this in your current shell to use the file values:',
      `  unset ${conflicts.map(c => c.key).join(' ')}`,
      '',
      'Or open a new terminal that does not have these set.',
    ];
    p.note(lines.join('\n'), 'Shell env conflicts');
  }

  const entry = findEngramEntry();
  if (!fs.existsSync(entry)) {
    p.log.warn(`Engram binary not found at ${entry} — if you installed from source, run \`bun run build\``);
  } else {
    p.log.info(`Engram binary         ${entry}`);
  }

  const registrationResults: Array<{ client: McpClient; ok: boolean; message: string }> = [];
  for (const id of installClients) {
    const client = MCP_CLIENTS.find(c => c.id === id);
    if (!client) continue;
    const s = p.spinner();
    s.start(`Registering Engram with ${client.label}  (up to 30s)`);
    const result = await runMcpAdd(client, entry, answers);
    if (result.ok) {
      s.stop(`${client.label} MCP registered ✓`);
      if (result.output) p.log.info(result.output);
    } else {
      s.stop(`${client.label} MCP registration failed — ${result.message}`);
      if (result.output) p.log.error(result.output);
    }
    registrationResults.push({ client, ok: result.ok, message: result.message });
  }

  // For any detected client we did NOT register, or any failure, print manual fallback instructions.
  const needsManual = registrationResults.some(r => !r.ok)
    || (detectedClients.length > installClients.length);
  if (needsManual) {
    printManualMcpInstructions(entry, answers, detectedClients);
  }

  // Offer to write usage instructions into each client's global instruction file
  const installedInstructionFiles = await offerInstructionInstall(installClients);
  void installedInstructionFiles;

  // Offer to install Claude Code hooks for auto-capture.
  // These are the HARD mechanism — instructions alone aren't reliable.
  if (installClients.includes('claude') || await hasCommand('claude')) {
    await offerHookInstall(dataDir);
  }

  const verifySteps: string[] = [];
  if (installClients.includes('claude')) {
    verifySteps.push('   Claude Code: /mcp menu → engram should appear');
  }
  if (installClients.includes('codex')) {
    verifySteps.push('   Codex CLI:   `codex mcp list` → engram should appear');
  }
  if (installClients.includes('gemini')) {
    verifySteps.push('   Gemini CLI:  `gemini mcp list` → engram should appear');
  }

  p.note(
    [
      '1. Verify the install:',
      '     engram doctor',
      '',
      '2. See your memory graph stats:',
      '     engram status',
      '',
      ...(installClients.length > 0
        ? [
          '3. Test in your AI client(s):',
          ...verifySteps,
          '   Try: "remember that I prefer TypeScript"',
          '        then later: "what languages do I prefer?"',
          '',
        ]
        : [
          '3. Register Engram with your MCP client (see Manual MCP install above).',
          '',
        ]),
      `Settings are auto-loaded from ${envPath} on every CLI run.`,
      'Edit that file to change provider, namespace, or other settings later.',
      `(Override at runtime with shell env vars, or set ENGRAM_NO_ENV_FILE=1 to skip auto-load.)`,
      '',
      'Learn more: https://github.com/kooroot/Engram#readme',
    ].join('\n'),
    'Next steps',
  );

  p.outro('Setup complete.');
}

function providerSummary(r: ProviderResult): string {
  if (r.provider === 'ollama') {
    return `  (${r.ollamaModel} @ ${r.ollamaUrl}, dim=${r.embeddingDimension})`;
  }
  if (r.provider === 'shell') {
    return `  (cmd: ${r.shellCmd}, dim=${r.embeddingDimension})`;
  }
  return '';
}

async function offerInstructionInstall(installedClientIds: McpClientId[]): Promise<InstructionFile[]> {
  // Default to instruction files for clients we just registered with MCP;
  // user can still toggle to include or exclude any.
  const allFiles = getInstructionFiles();
  if (allFiles.length === 0) return [];

  const initialValues = allFiles
    .filter(f => installedClientIds.includes(f.clientId as McpClientId))
    .map(f => f.clientId);

  const wantInstall = await p.confirm({
    message: 'Add Engram usage instructions to your AI CLIs?  (token-conscious template, idempotent)',
    initialValue: initialValues.length > 0,
  });
  ensureNotCancelled(wantInstall);
  if (!wantInstall) {
    return [];
  }

  const selected = await p.multiselect<InstructionClientId>({
    message: 'Pick which instruction files to update:',
    initialValues: initialValues as InstructionClientId[],
    required: false,
    options: allFiles.map(f => ({
      value: f.clientId,
      label: f.label,
      hint: f.path,
    })),
  });
  ensureNotCancelled(selected);
  const picks = selected as InstructionClientId[];
  const filesToUpdate = allFiles.filter(f => picks.includes(f.clientId));
  if (filesToUpdate.length === 0) return [];

  const updated: InstructionFile[] = [];
  for (const file of filesToUpdate) {
    try {
      const result = installInstructions(file);
      const verb = result.status === 'unchanged' ? 'already current' : result.status;
      p.log.success(`${file.label} — ${verb}  (${file.path})`);
      updated.push(file);
    } catch (err) {
      p.log.error(`${file.label} — failed: ${(err as Error).message}`);
    }
  }
  return updated;
}

function printManualMcpInstructions(
  entry: string,
  answers: OnboardAnswers,
  detected: readonly McpClient[],
): void {
  // Show command for each client; mark which ones aren't installed locally.
  const sections: string[] = [];
  for (const client of MCP_CLIENTS) {
    const installed = detected.some(d => d.id === client.id);
    const cmd = formatMcpAddCommand(client, entry, answers);
    sections.push(`# ${client.label}${installed ? '' : '  (not installed locally)'}`);
    sections.push(cmd);
    sections.push('');
  }
  p.note(sections.join('\n').trimEnd(), 'Manual MCP install commands');
}

function formatMcpAddCommand(client: McpClient, entry: string, answers: OnboardAnswers): string {
  const args = buildMcpAddArgs(client, entry, answers);
  const lines: string[] = [client.binary];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if ((a === '--env' || a === '-e') && i + 1 < args.length) {
      lines.push(`${a} ${quoteIfNeeded(args[i + 1])}`);
      i += 2;
    } else if (a === '--scope' && i + 1 < args.length) {
      lines.push(`${a} ${args[i + 1]}`);
      i += 2;
    } else if (a === '-s' && i + 1 < args.length) {
      lines.push(`${a} ${args[i + 1]}`);
      i += 2;
    } else {
      lines.push(quoteIfNeeded(a));
      i += 1;
    }
  }
  return lines.map((l, idx) => (idx === 0 ? l : `  ${l}`)).join(' \\\n');
}

function quoteIfNeeded(s: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ─── Hook installation (Claude Code only) ────────────────────────

// Hook scripts use execFileSync (not exec) to avoid shell injection.
const SESSION_START_HOOK = `#!/usr/bin/env node
// Engram SessionStart hook — injects "where we left off" project context.
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const project = basename(process.cwd());
try {
  // engram CLI emits the hook JSON itself when --hook-format is set.
  // It exits 0 silently when no context is found, so the hook injects nothing.
  const out = execFileSync(
    'engram',
    ['context', project, '--hook-format', 'SessionStart',
      '--strategy', 'graph', '--max-tokens', '1000'],
    { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  if (out) process.stdout.write(out);
} catch { /* silent — don't block session start */ }
`;

const PROMPT_INJECT_HOOK = `#!/usr/bin/env node
// Engram UserPromptSubmit hook — fetches relevant memories for the user's
// prompt and injects them as additionalContext for THIS turn only.
import { execFileSync } from 'node:child_process';

let payload = '';
for await (const chunk of process.stdin) payload += chunk;

let prompt = '';
try {
  const obj = JSON.parse(payload);
  prompt = (obj && typeof obj.prompt === 'string') ? obj.prompt : '';
} catch { /* malformed stdin — skip silently */ }

if (!prompt.trim()) process.exit(0);

try {
  const out = execFileSync(
    'engram',
    ['context', prompt, '--hook-format', 'UserPromptSubmit',
      '--strategy', 'hybrid', '--max-tokens', '1500'],
    { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  if (out) process.stdout.write(out);
} catch { /* engram down or no context — skip silently */ }
`;

const STOP_AUTOSAVE_HOOK = `#!/usr/bin/env node
// Engram Stop hook — runs after the session ends. Reads the transcript and
// extracts substance to save persistently via the host AI's light model.
import { spawn } from 'node:child_process';

let payload = '';
for await (const chunk of process.stdin) payload += chunk;

let transcriptPath = '';
try {
  const obj = JSON.parse(payload);
  transcriptPath =
    (obj && typeof obj.transcript_path === 'string') ? obj.transcript_path : '';
} catch { /* malformed stdin — skip silently */ }

if (!transcriptPath) process.exit(0);

// Spawn detached so the Stop hook returns immediately and the user isn't
// blocked waiting on the LLM extraction call. Stderr inherits so any
// auth/parse failure is visible in the user's terminal.
const child = spawn('engram',
  ['autosave', transcriptPath, '--min-bytes', '500'],
  { detached: true, stdio: ['ignore', 'ignore', 'inherit'] },
);
child.unref();
process.exit(0);
`;

export const HOOK_TEMPLATES = {
  sessionStart: SESSION_START_HOOK,
  promptInject: PROMPT_INJECT_HOOK,
  stopAutosave: STOP_AUTOSAVE_HOOK,
} as const;

async function offerHookInstall(dataDir: string): Promise<void> {
  const wantHooks = await p.confirm({
    message: 'Install auto-capture hooks for Claude Code?  (per-turn memory injection + post-session autosave)',
    initialValue: true,
  });
  ensureNotCancelled(wantHooks);
  if (!wantHooks) return;

  const hooksDir = path.join(dataDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  // Cleanup orphaned Phase 1 hook (replaced by prompt-inject.mjs).
  const orphaned = path.join(hooksDir, 'prompt-nudge.mjs');
  if (fs.existsSync(orphaned)) fs.rmSync(orphaned);

  // Write hook scripts
  const sessionStartPath = path.join(hooksDir, 'session-start.mjs');
  fs.writeFileSync(sessionStartPath, SESSION_START_HOOK, { mode: 0o755 });

  const promptInjectPath = path.join(hooksDir, 'prompt-inject.mjs');
  fs.writeFileSync(promptInjectPath, PROMPT_INJECT_HOOK, { mode: 0o755 });

  const stopAutosavePath = path.join(hooksDir, 'stop-autosave.mjs');
  fs.writeFileSync(stopAutosavePath, STOP_AUTOSAVE_HOOK, { mode: 0o755 });

  p.log.success(`Hook scripts written to ${hooksDir}`);

  // Merge into ~/.claude/settings.json
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      p.log.warn(`Could not parse ${settingsPath} — skipping hook install. Fix JSON and re-run.`);
      return;
    }
  }

  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown[]>;

  // Remove any existing engram hook entry from an event array, then add ours.
  function mergeHookEntry(event: string, newEntry: Record<string, unknown>): void {
    if (!Array.isArray(hooks[event])) hooks[event] = [];
    hooks[event] = (hooks[event] as Array<Record<string, unknown>>).filter(h => {
      const cmds = (h['hooks'] as Array<Record<string, unknown>>) ?? [];
      return !cmds.some(c => typeof c['command'] === 'string' && (c['command'] as string).includes('.engram/hooks/'));
    });
    (hooks[event] as unknown[]).push(newEntry);
  }

  mergeHookEntry('SessionStart', {
    hooks: [{
      type: 'command',
      command: `node ${sessionStartPath}`,
      timeout: 10,
      statusMessage: 'Loading engram memory…',
    }],
  });

  mergeHookEntry('UserPromptSubmit', {
    hooks: [{
      type: 'command',
      command: `node ${promptInjectPath}`,
      timeout: 5,
      async: true,
    }],
  });

  mergeHookEntry('Stop', {
    hooks: [{
      type: 'command',
      command: `node ${stopAutosavePath}`,
      timeout: 30,
    }],
  });

  settings['hooks'] = hooks;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  p.log.success('Claude Code hooks installed  (SessionStart + UserPromptSubmit + Stop)');
  p.log.info('SessionStart   → injects "where we left off" project context');
  p.log.info('UserPromptSubmit → fetches relevant memories for each prompt');
  p.log.info('Stop           → autosaves substance from completed sessions (needs ANTHROPIC_API_KEY)');
}
