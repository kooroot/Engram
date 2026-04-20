import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { HOOK_TEMPLATES } from '../../src/cli/onboard.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-hooks-'));
const STUB_BIN = path.join(TMP, 'bin');
const HOOK_DIR = path.join(TMP, 'hooks');
fs.mkdirSync(STUB_BIN);
fs.mkdirSync(HOOK_DIR);

// Stub `engram` binary that records its argv to a file then echoes a fixed response.
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
const stubPath = path.join(STUB_BIN, 'engram');
fs.writeFileSync(stubPath, STUB, { mode: 0o755 });

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
    env: { ...process.env, PATH: `${STUB_BIN}:${process.env['PATH']}`, ...env },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? -1 };
}

describe('twin Claude Code hook templates', () => {
  let logFile: string;

  beforeEach(() => {
    logFile = path.join(TMP, `log-${Date.now()}-${Math.random()}.txt`);
  });

  afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  describe('prompt-inject.mjs', () => {
    const scriptPath = writeHook('prompt-inject.mjs', HOOK_TEMPLATES.promptInject);

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
    const scriptPath = writeHook('stop-autosave.mjs', HOOK_TEMPLATES.stopAutosave);

    it('spawns engram autosave with the transcript_path', async () => {
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
  });

  describe('session-start.mjs', () => {
    const scriptPath = writeHook('session-start.mjs', HOOK_TEMPLATES.sessionStart);

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
