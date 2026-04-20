import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { getHookTemplates } from '../../src/cli/onboard.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-hooks-'));
const STUB_BIN_DIR = path.join(TMP, 'bin');
const HOOK_DIR = path.join(TMP, 'hooks');
fs.mkdirSync(STUB_BIN_DIR);
fs.mkdirSync(HOOK_DIR);

// Stub `engram` binary that records its argv to a file then echoes a fixed
// response read from ENGRAM_STUB_OUT (if set).
const STUB = `#!/usr/bin/env node
import { writeFileSync, readFileSync } from 'node:fs';
const log = process.env['ENGRAM_STUB_LOG'];
const outPath = process.env['ENGRAM_STUB_OUT'];
const exit = parseInt(process.env['ENGRAM_STUB_EXIT'] || '0', 10);
if (log) writeFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n', { flag: 'a' });
if (outPath) {
  process.stdout.write(readFileSync(outPath, 'utf8'));
}
process.exit(exit);
`;
const STUB_PATH = path.join(STUB_BIN_DIR, 'engram-stub');
fs.writeFileSync(STUB_PATH, STUB, { mode: 0o755 });

// Render templates with the absolute stub path baked in. This mirrors what
// `engram onboard` does in production: it resolves `which engram` at install
// time so the hook works under environments without the user's PATH.
const tpl = getHookTemplates({ engramBin: STUB_PATH, hostAi: 'claude' });

function writeHook(name: string, body: string): string {
  const p = path.join(HOOK_DIR, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

function runHook(
  scriptPath: string,
  stdin: string,
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('node', [scriptPath], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

describe('getHookTemplates substitution', () => {
  it('substitutes the engram binary path in all three templates', () => {
    const t = getHookTemplates({ engramBin: '/usr/local/bin/engram', hostAi: 'claude' });
    expect(t.sessionStart).toContain("ENGRAM_BIN = '/usr/local/bin/engram'");
    expect(t.promptInject).toContain("ENGRAM_BIN = '/usr/local/bin/engram'");
    expect(t.stopAutosave).toContain("ENGRAM_BIN = '/usr/local/bin/engram'");
    // No leftover placeholders.
    expect(t.sessionStart).not.toContain('__ENGRAM_BIN__');
    expect(t.promptInject).not.toContain('__ENGRAM_BIN__');
    expect(t.stopAutosave).not.toContain('__ENGRAM_BIN__');
    expect(t.sessionStart).not.toContain('__HOST_AI__');
    expect(t.promptInject).not.toContain('__HOST_AI__');
    expect(t.stopAutosave).not.toContain('__HOST_AI__');
    expect(t.stopAutosave).not.toContain('__STOP_NOOP__');
  });

  it('defaults to bare "engram" + claude when no args are given', () => {
    const t = getHookTemplates();
    expect(t.sessionStart).toContain("ENGRAM_BIN = 'engram'");
    expect(t.sessionStart).toContain("ENGRAM_HOST_AI = 'claude'");
  });

  it('accepts the legacy single-string signature as a claude variant', () => {
    const t = getHookTemplates('/some/bin/engram');
    expect(t.sessionStart).toContain("ENGRAM_BIN = '/some/bin/engram'");
    expect(t.sessionStart).toContain("ENGRAM_HOST_AI = 'claude'");
    // Claude variant: no `{"continue": true}` no-op in the Stop template.
    expect(t.stopAutosave).not.toContain('"continue": true');
  });
});

describe('getHookTemplates per-host-AI variants', () => {
  it('claude variant: Stop hook exits silently (no {"continue": true})', () => {
    const t = getHookTemplates({ engramBin: '/bin/engram', hostAi: 'claude' });
    expect(t.stopAutosave).not.toContain('"continue": true');
    expect(t.sessionStart).toContain("ENGRAM_HOST_AI = 'claude'");
    expect(t.promptInject).toContain("ENGRAM_HOST_AI = 'claude'");
    expect(t.stopAutosave).toContain("ENGRAM_HOST_AI = 'claude'");
  });

  it('codex variant: Stop hook emits {"continue": true} (codex requires non-empty stdout)', () => {
    const t = getHookTemplates({ engramBin: '/bin/engram', hostAi: 'codex' });
    expect(t.stopAutosave).toContain('"continue": true');
    expect(t.sessionStart).toContain("ENGRAM_HOST_AI = 'codex'");
    expect(t.promptInject).toContain("ENGRAM_HOST_AI = 'codex'");
    expect(t.stopAutosave).toContain("ENGRAM_HOST_AI = 'codex'");
  });

  it('gemini variant: Stop/SessionEnd hook emits {"continue": true} no-op (harmless)', () => {
    const t = getHookTemplates({ engramBin: '/bin/engram', hostAi: 'gemini' });
    expect(t.stopAutosave).toContain('"continue": true');
    expect(t.sessionStart).toContain("ENGRAM_HOST_AI = 'gemini'");
    expect(t.promptInject).toContain("ENGRAM_HOST_AI = 'gemini'");
    expect(t.stopAutosave).toContain("ENGRAM_HOST_AI = 'gemini'");
  });

  it('all variants forward ENGRAM_HOST_AI via env to the engram subprocess', () => {
    for (const hostAi of ['claude', 'codex', 'gemini'] as const) {
      const t = getHookTemplates({ engramBin: '/bin/engram', hostAi });
      // execFileSync / spawn options blob includes `env: { ...process.env, ENGRAM_HOST_AI }`
      expect(t.sessionStart).toContain('ENGRAM_HOST_AI');
      expect(t.sessionStart).toMatch(/env:\s*\{[^}]*ENGRAM_HOST_AI/);
      expect(t.promptInject).toMatch(/env:\s*\{[^}]*ENGRAM_HOST_AI/);
      expect(t.stopAutosave).toMatch(/env:\s*\{[^}]*ENGRAM_HOST_AI/);
    }
  });

  it('no leftover placeholders in any variant', () => {
    for (const hostAi of ['claude', 'codex', 'gemini'] as const) {
      const t = getHookTemplates({ engramBin: '/bin/engram', hostAi });
      for (const body of [t.sessionStart, t.promptInject, t.stopAutosave]) {
        expect(body).not.toContain('__ENGRAM_BIN__');
        expect(body).not.toContain('__HOST_AI__');
        expect(body).not.toContain('__STOP_NOOP__');
      }
    }
  });
});

describe('twin Claude Code hook templates', () => {
  let logFile: string;

  beforeEach(() => {
    logFile = path.join(TMP, `log-${Date.now()}-${Math.random()}.txt`);
  });

  afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  describe('prompt-inject.mjs', () => {
    const scriptPath = writeHook('prompt-inject.mjs', tpl.promptInject);

    it('forwards prompt text to engram context with --hook-format', () => {
      const fakeOut = path.join(TMP, 'fake-context-out.json');
      fs.writeFileSync(
        fakeOut,
        '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"X"}}',
      );

      const { stdout, status } = runHook(
        scriptPath,
        JSON.stringify({ prompt: 'tell me about engram', hook_event_name: 'UserPromptSubmit' }),
        { ENGRAM_STUB_LOG: logFile, ENGRAM_STUB_OUT: fakeOut },
      );
      expect(status).toBe(0);
      expect(stdout).toContain('hookSpecificOutput');
      const argv = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
      expect(argv).toContain('context');
      expect(argv).toContain('tell me about engram');
      expect(argv).toContain('--hook-format');
      expect(argv).toContain('UserPromptSubmit');
    });

    it('exits 0 silently when prompt is empty', () => {
      const { stdout, status } = runHook(
        scriptPath,
        JSON.stringify({ prompt: '   ' }),
        { ENGRAM_STUB_LOG: logFile },
      );
      expect(status).toBe(0);
      expect(stdout).toBe('');
      expect(fs.existsSync(logFile)).toBe(false); // engram never called
    });

    it('exits 0 silently when stdin is malformed JSON', () => {
      const { status, stdout } = runHook(scriptPath, 'not json', {
        ENGRAM_STUB_LOG: logFile,
      });
      expect(status).toBe(0);
      expect(stdout).toBe('');
    });

    it('exits 0 silently when engram exits non-zero', () => {
      const { status, stdout } = runHook(
        scriptPath,
        JSON.stringify({ prompt: 'x' }),
        { ENGRAM_STUB_LOG: logFile, ENGRAM_STUB_EXIT: '1' },
      );
      expect(status).toBe(0);
      expect(stdout).toBe('');
    });
  });

  describe('stop-autosave.mjs', () => {
    const scriptPath = writeHook('stop-autosave.mjs', tpl.stopAutosave);

    it('spawns engram autosave with transcript_path and --max-bytes guard', async () => {
      const { status } = runHook(
        scriptPath,
        JSON.stringify({ transcript_path: '/tmp/fake-transcript.jsonl' }),
        { ENGRAM_STUB_LOG: logFile },
      );
      expect(status).toBe(0);
      // Detached spawn — give it a moment to write the log
      await new Promise(r => setTimeout(r, 200));
      expect(fs.existsSync(logFile)).toBe(true);
      const argv = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
      expect(argv).toContain('autosave');
      expect(argv).toContain('/tmp/fake-transcript.jsonl');
      expect(argv).toContain('--min-bytes');
      expect(argv).toContain('500');
      expect(argv).toContain('--max-bytes');
      expect(argv).toContain('200000');
    });

    it('exits 0 silently when transcript_path is missing', () => {
      const { status } = runHook(
        scriptPath,
        JSON.stringify({ session_id: 'x' }),
        { ENGRAM_STUB_LOG: logFile },
      );
      expect(status).toBe(0);
      // engram should not be called
    });

    it('does not crash when engram binary is missing', async () => {
      // Render template pointing at a non-existent path
      const brokenTpl = getHookTemplates('/nonexistent/path/to/engram');
      const brokenScript = writeHook('stop-broken.mjs', brokenTpl.stopAutosave);
      const { status } = runHook(
        brokenScript,
        JSON.stringify({ transcript_path: '/tmp/x.jsonl' }),
      );
      // child.on('error') swallows the missing-binary error so the parent
      // hook still exits 0 and Claude Code doesn't see a crash.
      expect(status).toBe(0);
    });
  });

  describe('session-start.mjs', () => {
    const scriptPath = writeHook('session-start.mjs', tpl.sessionStart);

    it('calls engram context with project basename and --hook-format SessionStart', () => {
      const fakeOut = path.join(TMP, 'fake-session-out.json');
      fs.writeFileSync(
        fakeOut,
        '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Y"}}',
      );
      const { stdout, status } = runHook(scriptPath, '', {
        ENGRAM_STUB_LOG: logFile,
        ENGRAM_STUB_OUT: fakeOut,
      });
      expect(status).toBe(0);
      expect(stdout).toContain('hookSpecificOutput');
      const argv = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
      expect(argv).toContain('context');
      expect(argv).toContain('--hook-format');
      expect(argv).toContain('SessionStart');
    });
  });
});
