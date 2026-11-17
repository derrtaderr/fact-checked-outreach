// dlq --replay says it is replaying only once it is. docs/CEILING-FINDINGS-SPEC.md, minor 2.
//
// It used to print "replaying N dead letter(s)" before the credential and ceiling checks, so a
// replay that was then refused had already told the operator it started.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.mjs';
import { writeDeadLetter } from '../src/live/dlq.mjs';
import { signRaw } from '../src/stages/ingest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'announce-secret';

function runsWithLetters(count) {
  const runs = mkdtempSync(join(tmpdir(), 'signal-desk-announce-'));
  for (let index = 1; index <= count; index += 1) {
    const domain = `co${index}.example.com`;
    const raw = JSON.stringify({
      id: `sig-${index}`,
      source: 'rb2b',
      received_at: new Date().toISOString(),
      payload: {
        company: { name: `Company ${index}`, domain },
        contact: { name: 'Pat Example', email: `pat@${domain}` },
        sources: [`https://${domain}/about`],
      },
    });
    writeDeadLetter(runs, {
      reason: 'SIGNATURE_INVALID',
      source: `${index}.json`,
      signal_id: `sig-${index}`,
      signature: signRaw(SECRET, raw),
      raw,
    });
  }
  return runs;
}

async function dlq(argv, runs, env) {
  const out = [];
  const err = [];
  const code = await main({
    argv,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { SIGNAL_DESK_RUNS_DIR: runs, ...env },
    cwd: ROOT,
    now: () => new Date().toISOString(),
    httpTransport: async () => ({ status: 404, headers: { get: () => null }, text: async () => '{}' }),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const KEYS = { SIGNAL_DESK_ANTHROPIC_KEY: 'sk-ant-announce-0000', SIGNAL_DESK_SIGNAL_SECRET: SECRET };

test('a replay refused at the ceiling never says it was replaying', async () => {
  const { code, stdout, stderr } = await dlq(['dlq', '--replay', '--max-leads', '1'], runsWithLetters(2), KEYS);
  assert.equal(code, 2);
  assert.match(stderr, /LEAD_CEILING_EXCEEDED/);
  assert.doesNotMatch(stdout, /replaying/);
});

test('a replay refused for a missing key never says it was replaying', async () => {
  const { code, stdout, stderr } = await dlq(['dlq', '--replay'], runsWithLetters(1), {
    SIGNAL_DESK_SIGNAL_SECRET: SECRET,
  });
  assert.equal(code, 2);
  assert.match(stderr, /LIVE_KEY_MISSING/);
  assert.doesNotMatch(stdout, /replaying/);
});

test('a replay that clears its checks says so, before its run summary', async () => {
  const { code, stdout } = await dlq(['dlq', '--replay'], runsWithLetters(1), KEYS);
  assert.equal(code, 0);
  const announce = stdout.search(/replaying 1 dead letter\(s\)/);
  const summary = stdout.search(/signals in total/);
  assert.ok(announce !== -1, 'the replay is announced');
  assert.ok(summary !== -1 && announce < summary, 'and announced before the run it introduces');
});
