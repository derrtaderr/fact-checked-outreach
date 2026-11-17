// What one live lead can cost, in requests. docs/CEILING-FINDINGS-SPEC.md, finding 4.
//
// The README and the refusal message said "two model calls per lead". The model transport retries
// a failed call twice (DEFAULT_RETRIES = 2), so a lead is up to six model attempts, and every
// evidence fetch has the same shape. The count is derived from the code's own constants, so it
// cannot drift from them, and it never names a price: none is in this repo.

import test from 'node:test';
import assert from 'node:assert/strict';

import { leadRequests, runRequests, COST_FORMULA } from '../src/live/cost.mjs';
import { DEFAULT_RETRIES as MODEL_RETRIES, DEFAULT_MAX_TOKENS } from '../src/live/anthropic.mjs';
import { DEFAULT_RETRIES as FETCH_RETRIES } from '../src/live/http.mjs';
import { USAGE } from '../src/cli.mjs';

function signal(sources, identity) {
  return { id: 'x', payload: { sources, ...(identity === undefined ? {} : { identity_source: identity }) } };
}

test('a lead with two cited URLs and no identity source: 2 fetches and 2 model calls, up to 6 and 6', () => {
  const cost = leadRequests(signal(['https://a.example.com/1', 'https://a.example.com/2']));
  assert.equal(cost.urls, 2);
  assert.deepEqual(cost.fetches, { expected: 2, worst: 2 * (1 + FETCH_RETRIES) });
  assert.deepEqual(cost.modelCalls, { expected: 2, worst: 2 * (1 + MODEL_RETRIES) });
  assert.equal(cost.modelCalls.worst, 6, 'the constants today make it six model attempts');
});

test('an identity source the payload names is one more fetch', () => {
  const cost = leadRequests(signal(['https://a.example.com/1'], 'https://people.example.com/pat'));
  assert.equal(cost.urls, 2);
  assert.equal(cost.fetches.expected, 2);
});

test('a payload with no sources still makes its two model calls in the worst case count', () => {
  const cost = leadRequests({ id: 'y', payload: {} });
  assert.equal(cost.urls, 0);
  assert.equal(cost.fetches.worst, 0);
  assert.equal(cost.modelCalls.worst, 6);
});

test('a run total sums its leads, and each model attempt is capped at the token constant', () => {
  const total = runRequests([signal(['https://a.example.com/1']), signal(['https://b.example.com/1', 'https://b.example.com/2'])]);
  assert.equal(total.leads, 2);
  assert.deepEqual(total.fetches, { expected: 3, worst: 9 });
  assert.deepEqual(total.modelCalls, { expected: 4, worst: 12 });
  assert.equal(total.maxOutputTokensPerAttempt, DEFAULT_MAX_TOKENS);
});

test('the stated formula names the retries and the token cap and gives no price', () => {
  assert.match(COST_FORMULA, /6 model attempts/);
  assert.match(COST_FORMULA, /2,048/);
  assert.match(COST_FORMULA, /× 3/);
  assert.doesNotMatch(COST_FORMULA, /\$|USD|cents?\b/);
});

test('the usage text no longer says two model calls without the retries', () => {
  assert.match(USAGE, /up to 6/);
});

test('the over-ceiling refusal states the retry-aware count rather than "two model calls"', async () => {
  const { main } = await import('../src/cli.mjs');
  const { writeDeadLetter } = await import('../src/live/dlq.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const runs = mkdtempSync(join(tmpdir(), 'signal-desk-cost-'));
  for (let index = 1; index <= 2; index += 1) {
    writeDeadLetter(runs, { reason: 'SIGNATURE_INVALID', source: `${index}.json`, signal_id: `s${index}`, signature: 'bad', raw: JSON.stringify({ id: `s${index}` }) });
  }
  const err = [];
  const code = await main({
    argv: ['dlq', '--replay', '--max-leads', '1'],
    out: () => {},
    err: (line) => err.push(line),
    env: { SIGNAL_DESK_RUNS_DIR: runs, SIGNAL_DESK_ANTHROPIC_KEY: 'sk-ant-cost-0000', SIGNAL_DESK_SIGNAL_SECRET: 's' },
    httpTransport: async () => {
      throw new Error('no request may be made');
    },
  });
  assert.equal(code, 2);
  const stderr = err.join('\n');
  assert.match(stderr, /LEAD_CEILING_EXCEEDED/);
  assert.match(stderr, /up to 6 model attempts/);
  assert.doesNotMatch(stderr, /evidence fetches and two model calls,/);
});
