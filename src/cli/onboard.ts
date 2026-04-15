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
  provider: 'none' | 'openai' | 'shell' | 'ollama' | 'local';
  shellCmd?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
  embeddingDimension?: number;
  installClaude: boolean;
}

const CLAUDE_MCP_TIMEOUT_MS = 30_000;
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

async function runClaudeMcpAdd(entry: string, answers: OnboardAnswers): Promise<{ ok: boolean; message: string; output: string }> {
  return new Promise(resolve => {
    const args = [
      'mcp', 'add', 'engram',
      '--scope', 'user',
      '--env', `ENGRAM_DATA_DIR=${answers.dataDir}`,
      '--env', `ENGRAM_NAMESPACE=${answers.namespace}`,
      '--env', `ENGRAM_EMBEDDING_PROVIDER=${answers.provider}`,
    ];
    if (answers.shellCmd) args.push('--env', `ENGRAM_EMBEDDING_CMD=${answers.shellCmd}`);
    if (answers.ollamaUrl) args.push('--env', `OLLAMA_URL=${answers.ollamaUrl}`);
    if (answers.ollamaModel) args.push('--env', `OLLAMA_MODEL=${answers.ollamaModel}`);
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
  const hasClaudeCli = await hasCommand('claude');
  const ollamaReachable = await checkUrl('http://localhost:11434');

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
      installClaude: false,
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
    provider: providerResult.provider,
    shellCmd: providerResult.shellCmd,
    ollamaUrl: providerResult.ollamaUrl,
    ollamaModel: providerResult.ollamaModel,
    embeddingDimension: providerResult.embeddingDimension,
    installClaude,
  };

  p.note(
    [
      `Data dir:     ${dataDir}`,
      `Namespace:    ${namespace}`,
      `Provider:     ${providerResult.provider}` + providerSummary(providerResult),
      `Claude MCP:   ${installClaude ? 'yes (scope=user)' : 'no'}`,
    ].join('\n'),
    'Review — about to apply',
  );

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

function providerSummary(r: ProviderResult): string {
  if (r.provider === 'ollama') {
    return `  (${r.ollamaModel} @ ${r.ollamaUrl}, dim=${r.embeddingDimension})`;
  }
  if (r.provider === 'shell') {
    return `  (cmd: ${r.shellCmd}, dim=${r.embeddingDimension})`;
  }
  return '';
}

function printManualMcpInstructions(entry: string, answers: OnboardAnswers): void {
  const envFlags = [
    `--env ENGRAM_DATA_DIR=${answers.dataDir}`,
    `--env ENGRAM_NAMESPACE=${answers.namespace}`,
    `--env ENGRAM_EMBEDDING_PROVIDER=${answers.provider}`,
  ];
  if (answers.shellCmd) envFlags.push(`--env ENGRAM_EMBEDDING_CMD=${quoteShell(answers.shellCmd)}`);
  if (answers.ollamaUrl) envFlags.push(`--env OLLAMA_URL=${answers.ollamaUrl}`);
  if (answers.ollamaModel) envFlags.push(`--env OLLAMA_MODEL=${answers.ollamaModel}`);
  if (answers.embeddingDimension) envFlags.push(`--env ENGRAM_EMBEDDING_DIMENSION=${answers.embeddingDimension}`);
  const lines = [
    'claude mcp add engram --scope user \\',
    ...envFlags.map(f => `  ${f} \\`),
    `  -- node ${entry}`,
  ];
  p.note(lines.join('\n'), 'Manual MCP install');
}
