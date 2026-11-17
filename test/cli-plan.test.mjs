// run --live --plan: the preview that is actually free. docs/CEILING-FINDINGS-SPEC.md, finding 3.
//
// The README called the start refusal a free preview. It is free only when the folder is OVER the
// ceiling; under it, the same command is the real, billed run. --plan reads the same folder and
// prints what the run would do and what it could cost in requests, and it fetches nothing, calls no
// model, needs no key and writes nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, USAGE } from '../src/cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'signal-desk.mjs');

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `signal-desk-${prefix}-`));
}

// Unsigned on purpose: --plan verifies nothing, so it must not need a signature or a secret.
function writeSignals(dir, count, { sources = 1, identity = false } = {}) {
  for (let index = 1; index <= count; index += 1) {
    const domain = `co${index}.example.com`;
    const bytes = JSON.stringify({
      id: `sig-${index}`,
      source: 'rb2b',
      received_at: '2026-11-16T09:00:00.000Z',
      payload: {
        company: { name: `Company ${index}`, domain },
        contact: { name: 'Pat Example', email: `pat@${domain}` },
        sources: Array.from({ length: sources }, (_, n) => `https://${domain}/page-${n}`),
        ...(identity ? { identity_source: `https://people.example.com/${index}` } : {}),
      },
    });
    writeFileSync(join(dir, `${String(index).padStart(4, '0')}.json`), bytes);
  }
}

async function plan(argv, { env = {} } = {}) {
  const runs = tmp('plan-runs');
  const out = [];
  const err = [];
  const calls = [];
  const code = await main({
    argv,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { SIGNAL_DESK_RUNS_DIR: runs, ...env },
    cwd: ROOT,
    httpTransport: async (url) => {
      calls.push(url);
      throw new Error('--plan must not make a request');
    },
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n'), calls, runs };
}

test('--plan under the ceiling says the run would start and what it could cost, and does nothing', async () => {
  const signals = tmp('plan-under');
  writeSignals(signals, 3, { sources: 2 });

  const { code, stdout, calls, runs } = await plan(['run', '--live', '--plan', '--signals', signals]);

  assert.equal(code, 0);
  assert.match(stdout, /3 payload\(s\)/);
  assert.match(stdout, /ceiling of 10/);
  assert.match(stdout, /would start/);
  assert.match(stdout, /this is the real, billed run/i, 'it says plainly that the real command bills');
  // 3 leads × 2 URLs = 6 fetches expected, 18 worst; 3 × 2 = 6 model calls, 18 attempts worst.
  assert.match(stdout, /expected\s+6 fetch\(es\) and 6 model call\(s\)/);
  assert.match(stdout, /worst case\s+18 fetch\(es\) and 18 model attempt\(s\)/);
  assert.match(stdout, /2,048 output tokens/);
  assert.match(stdout, /price per request is your provider's/);
  assert.match(stdout, /upper bound/, 'it says signatures were not checked, so the count is an upper bound');
  assert.equal(calls.length, 0, 'not one request');
  assert.deepEqual(readdirSync(runs), [], 'nothing written');
});

test('--plan counts an identity source as one more fetch per lead', async () => {
  const signals = tmp('plan-identity');
  writeSignals(signals, 2, { sources: 1, identity: true });
  const { stdout } = await plan(['run', '--live', '--plan', '--signals', signals]);
  assert.match(stdout, /expected\s+4 fetch\(es\) and 4 model call\(s\)/);
});

test('--plan over the ceiling says the run would be refused at start, which bills nothing', async () => {
  const signals = tmp('plan-over');
  writeSignals(signals, 3);
  const { code, stdout, calls } = await plan(['run', '--live', '--plan', '--signals', signals, '--max-leads', '2']);
  assert.equal(code, 0, 'a plan is a report, not a refusal');
  assert.match(stdout, /ceiling of 2/);
  assert.match(stdout, /would be refused at start/);
  assert.match(stdout, /LEAD_CEILING_EXCEEDED/);
  assert.match(stdout, /--max-leads 3/);
  assert.equal(calls.length, 0);
});

test('--plan needs no key and no signal secret, because it contacts nobody and verifies nothing', () => {
  const signals = tmp('plan-nokey');
  writeSignals(signals, 1);
  const runs = tmp('plan-nokey-runs');
  const stdout = execFileSync(process.execPath, [BIN, 'run', '--live', '--plan', '--signals', signals], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SIGNAL_DESK_RUNS_DIR: runs },
  });
  assert.match(stdout, /would start/);
  assert.doesNotMatch(stdout, /LIVE_KEY_MISSING|LIVE_SECRET_MISSING/);
  assert.deepEqual(readdirSync(runs), []);
});

test('--plan still refuses a bad ceiling and a missing folder, the way the run would', async () => {
  const bad = await plan(['run', '--live', '--plan', '--max-leads', '0']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /LEAD_CEILING_INVALID/);

  const missing = await plan(['run', '--live', '--plan', '--signals', join(tmp('plan-missing'), 'nope')]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no signal directory/);
});

test('--plan on a fixture run refuses rather than being ignored', async () => {
  const { code, stderr } = await plan(['run', '--plan']);
  assert.equal(code, 2);
  assert.doesNotMatch(stderr, /unknown flag/);
  assert.match(stderr, /--plan previews a live run/);
  assert.match(stderr, /run --live --plan/);
});

test('the usage text documents --plan as the free preview', () => {
  assert.match(USAGE, /run\s+--live, --signals <dir>, --max-leads <n>, --plan/);
  assert.match(USAGE, /--plan/);
});
