// What the ceiling refusals say. docs/CEILING-FINDINGS-SPEC.md, minors 1, 3 and 4.
//
// 1. An operator who typed a LOW ceiling on purpose was told to raise it. The advice now says the
//    ceiling was theirs and leads with splitting the run.
// 3. The start check counts parsed payloads, including ones ingest will refuse for a bad signature,
//    so the count can be higher than what would bill. The refusal says so.
// 4. The invalid-ceiling copy said "a whole number", and the parser also refuses whole numbers
//    written 007, +5 or 1e3. The copy now says what is accepted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.mjs';
import { writeDeadLetter } from '../src/live/dlq.mjs';
import { parseMaxLeads } from '../src/live/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function runsWithLetters(count) {
  const runs = mkdtempSync(join(tmpdir(), 'signal-desk-msg-'));
  for (let index = 1; index <= count; index += 1) {
    writeDeadLetter(runs, {
      reason: 'SIGNATURE_INVALID',
      source: `${index}.json`,
      signal_id: `s${index}`,
      signature: 'bad',
      raw: JSON.stringify({ id: `s${index}` }),
    });
  }
  return runs;
}

async function replay(argv, runs) {
  const out = [];
  const err = [];
  const code = await main({
    argv,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { SIGNAL_DESK_RUNS_DIR: runs, SIGNAL_DESK_ANTHROPIC_KEY: 'sk-ant-msg-0000', SIGNAL_DESK_SIGNAL_SECRET: 's' },
    cwd: ROOT,
    httpTransport: async () => {
      throw new Error('no request may be made');
    },
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('over the DEFAULT ceiling, the refusal says it was the default and offers a raise on purpose', async () => {
  const { code, stderr } = await replay(['dlq', '--replay'], runsWithLetters(11));
  assert.equal(code, 2);
  assert.match(stderr, /the default ceiling of 10/);
  assert.match(stderr, /--max-leads 11/);
});

test('over a ceiling the operator TYPED, the refusal says it was theirs and leads with splitting', async () => {
  const { code, stderr } = await replay(['dlq', '--replay', '--max-leads', '2'], runsWithLetters(3));
  assert.equal(code, 2);
  assert.match(stderr, /you set with --max-leads 2/);
  assert.doesNotMatch(stderr, /raise the ceiling on purpose/, 'not told to undo the cap they just chose');
  // Revised in fix wave 1 (M5): this drives dlq --replay, which cannot be split, so its advice says
  // that instead. Split-before-raise for run --live is in test/plan-urls-dlq-advice.test.mjs.
  assert.match(stderr, /cannot be split/);
});

test('the refusal says its count includes payloads ingest would refuse for a bad signature', async () => {
  const { stderr } = await replay(['dlq', '--replay', '--max-leads', '2'], runsWithLetters(3));
  assert.match(stderr, /counts every parsed payload/);
  assert.match(stderr, /bad signature/);
});

test('the invalid-ceiling copy says what is accepted rather than "a whole number"', () => {
  let message = '';
  try {
    parseMaxLeads('007');
  } catch (error) {
    message = error.message;
  }
  assert.doesNotMatch(message, /whole number/);
  assert.match(message, /plain digits/);
  assert.match(message, /leading zero/);
  assert.match(message, /"007"/);
});

test('the README describes the accepted ceiling the same way the refusal does', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /anything that is not a\s+whole number refuses/);
  assert.match(readme, /plain digits/);
});
