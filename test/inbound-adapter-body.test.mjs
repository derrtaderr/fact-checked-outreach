// A failure after the request may have reached the service is ambiguous. docs/INBOUND-SPEC.md, "Adapters".
//
// Review pass 1, B2: the Slack adapter read the response body outside its try, so a 200 whose body
// read threw (a socket torn after the headers) escaped as a plain Error, was journaled slack_failed,
// and the next tick posted again. Every await after the request left now fails as a named, ambiguous
// error, and the engine treats anything that is not a named, unambiguous refusal as "may have landed".

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSlackAdapter } from '../src/inbound/slack.mjs';
import { createHubSpotAdapter } from '../src/inbound/hubspot.mjs';
import { tick } from '../src/inbound/engine.mjs';
import { Journal } from '../src/inbound/journal.mjs';
import { eventOf, world, T0 } from './helpers/inbound-world.mjs';

const SL = 'xoxb-canary-BODY-READ-DO-NOT-LOG';
const HS = 'pat-canary-BODY-READ-DO-NOT-LOG';
const tornBody = (secret) => ({ status: 200, text: async () => { throw new Error(`terminated, Bearer ${secret}`); } });
const reply = (status, body) => ({ status, text: async () => JSON.stringify(body) });

test('B2: a Slack post answered 200 whose body read throws is ambiguous, with the token scrubbed', async () => {
  const slack = createSlackAdapter({ transport: async () => tornBody(SL), token: SL, scrub: (t) => t.split(SL).join('[redacted]') });
  await assert.rejects(slack.post({ channel: 'U1', text: 't', blocks: [] }), (error) => {
    assert.equal(error.code, 'SLACK_UNREACHABLE');
    assert.equal(error.ambiguous, true);
    assert.ok(!error.message.includes(SL));
    return true;
  });
});

test('B2: a Slack history whose body read throws is SLACK_UNSEARCHABLE, never "not found"', async () => {
  let n = 0;
  const transport = async () => (++n === 1 ? reply(200, { ok: true, channel: { id: 'D1' } }) : tornBody(SL));
  const slack = createSlackAdapter({ transport, token: SL });
  await assert.rejects(slack.find({ channel: 'U1', marker: 'm', oldest: T0 }), (error) => {
    assert.equal(error.code, 'SLACK_UNSEARCHABLE');
    return true;
  });
});

test('B2: a HubSpot answer whose body read throws is HUBSPOT_UNAVAILABLE and ambiguous, with the token scrubbed', async () => {
  const hubspot = createHubSpotAdapter({ transport: async () => tornBody(HS), token: HS, scrub: (t) => t.split(HS).join('[redacted]') });
  for (const call of [() => hubspot.assign({ email: 'a@b.test', ownerId: '1' }), () => hubspot.read({ email: 'a@b.test' })]) {
    await assert.rejects(call(), (error) => {
      assert.equal(error.code, 'HUBSPOT_UNAVAILABLE');
      assert.equal(error.ambiguous, true);
      assert.ok(!error.message.includes(HS));
      return true;
    });
  }
});

test('B2: a post that landed but whose answer could not be read is found on the next tick, not posted again', async () => {
  const w = world();
  const stored = [];
  let accepted = 0;
  const transport = async (url, options) => {
    if (url.endsWith('chat.postMessage')) {
      accepted += 1;
      stored.push({ text: JSON.parse(options.body).text, ts: `9.${accepted}` });
      return accepted === 1 ? tornBody(SL) : reply(200, { ok: true, ts: `9.${accepted}` });
    }
    if (url.endsWith('conversations.open')) return reply(200, { ok: true, channel: { id: 'D1' } });
    if (url.includes('conversations.history')) return reply(200, { ok: true, messages: stored });
    throw new Error(`unexpected ${url}`);
  };
  const slack = createSlackAdapter({ transport, token: SL });
  const once = () => tick({ events: [eventOf(1)], rotation: w.rotation, journal: Journal.open(w.path), hubspot: w.hubspot, slack, now: () => T0 });
  assert.equal((await once()).outcomes[0].status, 'SLACK_UNCONFIRMED');
  assert.ok(!Journal.open(w.path).entries().some((e) => e.type === 'slack_failed'), 'no slack_failed for a post that may exist');
  assert.equal((await once()).outcomes[0].status, 'ASSIGNED');
  assert.equal(accepted, 1, 'Slack accepted one post');
});

test('B2: an unnamed error from a Slack post is treated as "may have landed", never as a refusal', async () => {
  const w = world();
  let posts = 0;
  const slack = {
    async post() { posts += 1; throw new TypeError('something unexpected inside the adapter'); },
    async find() { return null; },
  };
  const once = () => tick({ events: [eventOf(1)], rotation: w.rotation, journal: Journal.open(w.path), hubspot: w.hubspot, slack, now: () => T0 });
  const first = await once();
  assert.equal(first.outcomes[0].status, 'SLACK_UNCONFIRMED');
  assert.ok(!Journal.open(w.path).entries().some((e) => e.type === 'slack_failed'));
});
