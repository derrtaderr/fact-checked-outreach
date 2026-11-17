// A value flag says one thing, once. docs/CEILING-FINDINGS-SPEC.md, finding 1.
//
// `run --live --max-leads 500 --max-leads 5` used to run under 500: the flag reader took the first
// match and dropped the rest, so a run could bill above the last ceiling the operator typed. The
// same reader serves every value flag, so every one of them is held to the same rule here: given
// twice, or given with no value, it refuses before anything is read, fetched or written.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.mjs';
import { signRaw } from '../src/stages/ingest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'flag-values-secret';
const KEY = 'sk-ant-canary-flags-0000';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `signal-desk-${prefix}-`));
}

function writeSignals(dir, count) {
  for (let index = 1; index <= count; index += 1) {
    const domain = `co${index}.example.com`;
    const bytes = JSON.stringify({
      id: `sig-${index}`,
      source: 'rb2b',
      received_at: new Date().toISOString(),
      payload: {
        company: { name: `Company ${index}`, domain },
        contact: { name: 'Pat Example', email: `pat@${domain}`, title: 'VP Revenue Operations' },
        intent: { page: '/pricing', visits: 2 },
        sources: [`https://${domain}/about`],
      },
    });
    const name = String(index).padStart(4, '0');
    writeFileSync(join(dir, `${name}.json`), bytes);
    writeFileSync(join(dir, `${name}.json.sig`), `${signRaw(SECRET, bytes)}\n`);
  }
}

function recordingTransport() {
  const calls = [];
  return {
    calls,
    transport: async (url) => {
      calls.push(url);
      return { status: 404, headers: { get: () => null }, text: async () => '{}' };
    },
  };
}

async function cli(argv, { runs, cwd = ROOT, transport } = {}) {
  const out = [];
  const err = [];
  const code = await main({
    argv,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { SIGNAL_DESK_RUNS_DIR: runs, SIGNAL_DESK_ANTHROPIC_KEY: KEY, SIGNAL_DESK_SIGNAL_SECRET: SECRET },
    cwd,
    httpTransport: transport,
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('--max-leads given twice refuses, names both values, and bills nothing', async () => {
  const runs = tmp('rep-max');
  const signals = tmp('rep-max-signals');
  writeSignals(signals, 3);
  const fake = recordingTransport();

  const { code, stderr } = await cli(
    ['run', '--live', '--signals', signals, '--max-leads', '500', '--max-leads', '5'],
    { runs, transport: fake.transport },
  );

  assert.equal(code, 2);
  assert.match(stderr, /FLAG_REPEATED/);
  assert.match(stderr, /--max-leads/);
  assert.match(stderr, /"500"/);
  assert.match(stderr, /"5"/);
  assert.equal(fake.calls.length, 0, 'not one request was made');
  assert.deepEqual(readdirSync(runs), [], 'nothing was written');
});

test('--max-leads given twice on dlq --replay refuses the same way', async () => {
  const runs = tmp('rep-dlq');
  const { code, stderr } = await cli(['dlq', '--replay', '--max-leads', '1', '--max-leads', '9'], { runs });
  assert.equal(code, 2);
  assert.match(stderr, /FLAG_REPEATED/);
});

test('--signals given twice refuses rather than running the first folder', async () => {
  const runs = tmp('rep-sig');
  const one = tmp('rep-sig-one');
  const two = tmp('rep-sig-two');
  writeSignals(one, 1);
  writeSignals(two, 1);
  const fake = recordingTransport();

  const { code, stderr } = await cli(['run', '--live', '--signals', one, '--signals', two], {
    runs,
    transport: fake.transport,
  });

  assert.equal(code, 2);
  assert.match(stderr, /FLAG_REPEATED/);
  assert.match(stderr, /--signals/);
  assert.equal(fake.calls.length, 0);
});

test('--by and --note given twice on approve or reject refuse before any decision is recorded', async () => {
  for (const verb of ['approve', 'reject']) {
    for (const flag of ['--by', '--note']) {
      const runs = tmp('rep-decide');
      const { code, stderr } = await cli([verb, 'abc', flag, 'one', flag, 'two'], { runs });
      assert.equal(code, 2, `${verb} ${flag} twice should refuse`);
      assert.match(stderr, /FLAG_REPEATED/);
      assert.match(stderr, new RegExp(flag));
      assert.deepEqual(readdirSync(runs), [], 'no decision store was written');
    }
  }
});

test('a boolean flag given twice still means the one thing it says', async () => {
  const runs = tmp('rep-bool');
  const { code, stderr } = await cli(['dlq', '--replay', '--replay'], { runs });
  assert.doesNotMatch(stderr, /FLAG_REPEATED/);
  assert.equal(code, 0, 'an empty dead-letter queue replays nothing and exits 0');
});

test('--signals with no value refuses rather than falling back to ./signals', async () => {
  // The working directory holds a ./signals folder, so the old fallback had something to run.
  const cwd = tmp('miss-sig-cwd');
  const fallback = join(cwd, 'signals');
  mkdirSync(fallback);
  writeSignals(fallback, 1);
  const runs = tmp('miss-sig');
  const fake = recordingTransport();

  const { code, stderr } = await cli(['run', '--live', '--signals'], { runs, cwd, transport: fake.transport });

  assert.equal(code, 2);
  assert.match(stderr, /FLAG_VALUE_MISSING/);
  assert.match(stderr, /--signals/);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(readdirSync(runs), []);
});

test('a value flag followed by another flag is a missing value, not a value', async () => {
  const runs = tmp('miss-next');
  const { code, stderr } = await cli(['run', '--live', '--signals', '--max-leads', '5'], { runs });
  assert.equal(code, 2);
  assert.match(stderr, /FLAG_VALUE_MISSING/);
  assert.match(stderr, /--signals/);
});

test('--by and --note with no value refuse rather than recording a default', async () => {
  for (const flag of ['--by', '--note']) {
    const runs = tmp('miss-decide');
    const { code, stderr } = await cli(['approve', 'abc', flag], { runs });
    assert.equal(code, 2);
    assert.match(stderr, /FLAG_VALUE_MISSING/);
    assert.match(stderr, new RegExp(flag));
  }
});

test('--max-leads with no value keeps its own refusal, LEAD_CEILING_INVALID', async () => {
  const runs = tmp('miss-max');
  const { code, stderr } = await cli(['run', '--live', '--max-leads'], { runs });
  assert.equal(code, 2);
  assert.match(stderr, /LEAD_CEILING_INVALID/);
  assert.doesNotMatch(stderr, /FLAG_VALUE_MISSING/);
});
