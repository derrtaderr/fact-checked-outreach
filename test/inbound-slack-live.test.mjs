// The live Slack adapter, against a fake transport only. docs/INBOUND-SPEC.md, "Adapters".
//
// There is no Slack workspace for this lane, so the live post is NOT RUN anywhere. These tests pin the
// request shape and, more importantly, which failures are ambiguous: only an answer that proves nothing
// was posted may be retried by posting again.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSlackAdapter, SLACK_BASE } from '../src/inbound/slack.mjs';
import { secretScrubber } from '../src/live/keys.mjs';
import { markerFor } from '../src/inbound/message.mjs';

const TOKEN = 'xoxb-canary-DO-NOT-LOG-5d2e';

function response(status, body) {
  return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}
function transport(script) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined, headers: options.headers });
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}
const adapter = (fake) => createSlackAdapter({ transport: fake, token: TOKEN, scrub: secretScrubber([TOKEN]) });
const message = { channel: 'U0001', text: `${markerFor('k', 0)} New inbound lead: Acme.`, blocks: [{ type: 'section' }], marker: markerFor('k', 0) };

test('the adapter refuses to be built without a transport or a token', () => {
  assert.throws(() => createSlackAdapter({ token: TOKEN }), TypeError);
  assert.throws(() => createSlackAdapter({ transport: async () => {}, token: '' }), TypeError);
});

test('post sends chat.postMessage to the rep with no link unfurling, and returns the ts', async () => {
  const fake = transport([response(200, { ok: true, ts: '1700000000.000100', channel: 'D1' })]);
  assert.deepEqual(await adapter(fake).post(message), { ts: '1700000000.000100' });
  assert.equal(fake.calls[0].url, `${SLACK_BASE}/chat.postMessage`);
  assert.equal(fake.calls[0].method, 'POST');
  assert.equal(fake.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(fake.calls[0].body, {
    channel: 'U0001', text: message.text, blocks: message.blocks, unfurl_links: false, unfurl_media: false,
  });
});

test('ok: false and a 429 prove nothing was posted, so they are not ambiguous', async () => {
  for (const [answer, code] of [
    [response(200, { ok: false, error: 'channel_not_found' }), 'SLACK_REJECTED'],
    [response(429, { ok: false, error: 'ratelimited' }), 'SLACK_RATE_LIMITED'],
  ]) {
    await assert.rejects(adapter(transport([answer])).post(message), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.ambiguous, false);
      return true;
    });
  }
});

test('a dropped connection or a 5xx may have posted, so they are ambiguous', async () => {
  for (const answer of [new Error('socket hang up'), response(503, 'unavailable')]) {
    await assert.rejects(adapter(transport([answer])).post(message), (error) => {
      assert.equal(error.code, 'SLACK_UNREACHABLE');
      assert.equal(error.ambiguous, true);
      return true;
    });
  }
});

test('find opens the DM and searches its history from the attempt onward for the marker', async () => {
  const fake = transport([
    response(200, { ok: true, channel: { id: 'D9' } }),
    response(200, { ok: true, messages: [{ ts: '1.1', text: 'other' }, { ts: '1.2', text: `${markerFor('k', 0)} New inbound lead: Acme.` }] }),
  ]);
  assert.deepEqual(await adapter(fake).find({ channel: 'U0001', marker: markerFor('k', 0), oldest: '2026-03-01T09:00:00.000Z' }), { ts: '1.2' });
  assert.equal(fake.calls[0].url, `${SLACK_BASE}/conversations.open`);
  assert.deepEqual(fake.calls[0].body, { users: 'U0001' });
  const history = new URL(fake.calls[1].url);
  assert.equal(history.pathname.endsWith('/conversations.history'), true);
  assert.equal(history.searchParams.get('channel'), 'D9');
  assert.equal(history.searchParams.get('oldest'), String(Date.parse('2026-03-01T09:00:00.000Z') / 1000 - 60));
});

test('find returns null when the marker is not in the history', async () => {
  const fake = transport([response(200, { ok: true, channel: { id: 'D9' } }), response(200, { ok: true, messages: [] })]);
  assert.equal(await adapter(fake).find({ channel: 'U0001', marker: markerFor('k', 0), oldest: '2026-03-01T09:00:00.000Z' }), null);
});

test('a history Slack will not give (a missing scope) is SLACK_UNSEARCHABLE, never "not found"', async () => {
  const fake = transport([response(200, { ok: false, error: 'missing_scope', needed: 'im:history' })]);
  await assert.rejects(adapter(fake).find({ channel: 'U0001', marker: 'm', oldest: '2026-03-01T09:00:00.000Z' }), (error) => {
    assert.equal(error.code, 'SLACK_UNSEARCHABLE');
    assert.match(error.message, /missing_scope/);
    return true;
  });
});

test('the token never appears in an error', async () => {
  await assert.rejects(adapter(transport([new Error(`bad auth ${TOKEN}`)])).post(message), (error) => !error.message.includes(TOKEN));
});
