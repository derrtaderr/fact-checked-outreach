// Every token on the command line is accounted for, or the command refuses.
// docs/CEILING-FINDINGS-SPEC.md, fix wave 1, B1 and I6.
//
// The flag check skipped any token that did not start with "--". So `run --live -plan`, `—plan`
// (an em dash, which some editors and chat apps substitute for two hyphens) and `plan` all ran the
// REAL billed run: a mistyped preview was the bill. `-max-leads 3` ran under the default ceiling of
// 10. And `run --signals <dir>` without --live ran the fixture demo and ignored the folder. Each of
// these is now refused before anything is read, fetched or written.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.mjs';
import { signRaw } from '../src/stages/ingest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'strict-args-secret';

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
        contact: { name: 'Pat Example', email: `pat@${domain}` },
        sources: [`https://${domain}/about`],
      },
    });
    const name = String(index).padStart(4, '0');
    writeFileSync(join(dir, `${name}.json`), bytes);
    writeFileSync(join(dir, `${name}.json.sig`), `${signRaw(SECRET, bytes)}\n`);
  }
}

async function cli(argv) {
  const runs = tmp('strict-runs');
  const out = [];
  const err = [];
  const calls = [];
  const code = await main({
    argv,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { SIGNAL_DESK_RUNS_DIR: runs, SIGNAL_DESK_ANTHROPIC_KEY: 'sk-ant-strict-0000', SIGNAL_DESK_SIGNAL_SECRET: SECRET },
    cwd: ROOT,
    httpTransport: async (url) => {
      calls.push(url);
      return { status: 404, headers: { get: () => null }, text: async () => '{}' };
    },
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n'), calls, written: readdirSync(runs) };
}

function assertRefusedCleanly(result, token) {
  assert.equal(result.code, 2, `${token} should refuse`);
  assert.ok(result.stderr.includes(token), `the refusal names ${token}`);
  assert.equal(result.calls.length, 0, `${token}: not one request`);
  assert.deepEqual(result.written, [], `${token}: nothing written`);
}

test('a mistyped --plan never runs the billed run: -plan, em dash, en dash, minus sign, bare word', async () => {
  const signals = tmp('strict-plan');
  writeSignals(signals, 3);
  for (const token of ['-plan', '—plan', '–plan', '−plan', 'plan']) {
    assertRefusedCleanly(await cli(['run', '--live', '--signals', signals, token]), token);
  }
});

test('-max-leads 3 is refused rather than running under the default ceiling', async () => {
  const signals = tmp('strict-max');
  writeSignals(signals, 3);
  assertRefusedCleanly(await cli(['run', '--live', '--signals', signals, '-max-leads', '3']), '-max-leads');
});

test('a dash-like flag says flags take two ASCII hyphens', async () => {
  const signals = tmp('strict-dash');
  writeSignals(signals, 1);
  const { stderr } = await cli(['run', '--live', '--signals', signals, '—plan']);
  assert.match(stderr, /two ASCII hyphens/);
  assert.match(stderr, /--plan/);
});

test('dlq refuses stray tokens the same way, so a mistyped replay flag never replays', async () => {
  for (const token of ['-replay', '—max-leads', 'replay']) {
    const result = await cli(['dlq', token]);
    assert.equal(result.code, 2, `dlq ${token}`);
    assert.ok(result.stderr.includes(token));
  }
  const ceiling = await cli(['dlq', '--replay', '-max-leads', '2']);
  assert.equal(ceiling.code, 2);
  assert.equal(ceiling.calls.length, 0);
});

test('queue takes no positional argument', async () => {
  const { code, stderr } = await cli(['queue', 'extra']);
  assert.equal(code, 2);
  assert.match(stderr, /unexpected argument "extra"/);
});

test('approve and reject keep their one positional, the id, and refuse a second', async () => {
  for (const verb of ['approve', 'reject']) {
    const extra = await cli([verb, 'abc', 'def']);
    assert.equal(extra.code, 2);
    assert.match(extra.stderr, /unexpected argument "def"/);

    const dashed = await cli([verb, 'abc', '-by', 'x']);
    assert.equal(dashed.code, 2);
    assert.match(dashed.stderr, /-by/);

    // The id itself is still accepted: with no runs, the refusal is about the runs, not the argument.
    const ok = await cli([verb, 'abc', '--by', 'x']);
    assert.doesNotMatch(ok.stderr, /unexpected argument|unknown flag/);
  }
});

test('replay, explain and dashboard keep their one positional and refuse a second', async () => {
  for (const verb of ['replay', 'explain', 'dashboard']) {
    const extra = await cli([verb, 'run-abc', 'more']);
    assert.equal(extra.code, 2, `${verb} with two positionals`);
    assert.match(extra.stderr, /unexpected argument "more"/);

    const ok = await cli([verb, 'run-abc']);
    assert.doesNotMatch(ok.stderr, /unexpected argument|unknown flag/, `${verb} with its one positional`);
  }
});

test('a positional that looks like a dashed flag is refused, not taken as an id', async () => {
  const { code, stderr } = await cli(['replay', '—live']);
  assert.equal(code, 2);
  assert.match(stderr, /two ASCII hyphens/);
});

test('run --signals without --live refuses rather than running the fixture demo and ignoring the folder', async () => {
  const signals = tmp('strict-fixture');
  writeSignals(signals, 2);
  const result = await cli(['run', '--signals', signals]);
  assert.equal(result.code, 2);
  assert.doesNotMatch(result.stderr, /unknown flag/);
  assert.match(result.stderr, /--signals names the folder a live run reads/);
  assert.match(result.stderr, /run --live --signals/);
  assert.deepEqual(result.written, [], 'the fixture run did not run');
  assert.doesNotMatch(result.stdout, /signals in total/);
});

test('the fixture demo with no arguments still runs', async () => {
  const result = await cli(['run']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /14 signals in total/);
});
