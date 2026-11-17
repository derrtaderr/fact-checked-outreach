// The marker a crashed post is found by. docs/INBOUND-SPEC.md, "The journal" (after slack_attempt)
// and "Escaping and secrets".
//
// Review pass 1, B5: the marker carried the raw signal id, the post sent it HTML-escaped (& -> &amp;)
// and find searched for the raw form, so a key like `sig-a&b` was never found and the post repeated.
// The marker is now a digest in a fixed safe alphabet, identical when sent and when searched, and it
// comes first in every field that can be cut, so truncation can never drop it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSlackMessage, markerFor } from '../src/inbound/message.mjs';
import { createSlackAdapter } from '../src/inbound/slack.mjs';
import { tick } from '../src/inbound/engine.mjs';
import { Journal } from '../src/inbound/journal.mjs';
import { eventOf, world, T0 } from './helpers/inbound-world.mjs';

// Slack's documented limits, read 2026-11-16: chat.postMessage `text` "limit ... to 4,000 characters"
// (https://docs.slack.dev/reference/methods/chat.postMessage); a section block's text "maximum length is
// 3000 characters" (https://docs.slack.dev/reference/block-kit/blocks/section-block).
const SLACK_TEXT_MAX = 4000;
const SLACK_SECTION_MAX = 3000;

const rep = { id: 'ana', slack_user_id: 'U1', hubspot_owner_id: 'o-ana' };
const lead = (overrides = {}) => ({ ...eventOf(1).lead, ...overrides });

test('B5: the marker is a digest in a safe alphabet, distinct per key and attempt, for any key', () => {
  const keys = ['sig-1', 'sig-a&b', 'sig-<!channel>', 'sig "q" ‮', 'x'.repeat(5000)];
  const seen = new Set();
  for (const key of keys) {
    for (const attempt of [0, 1, 2]) {
      const marker = markerFor(key, attempt);
      assert.match(marker, /^signal-desk-[0-9a-f]{24}$/, `marker for ${JSON.stringify(key.slice(0, 20))}`);
      seen.add(marker);
    }
  }
  assert.equal(seen.size, keys.length * 3);
  assert.equal(markerFor('sig-1', 0), markerFor('sig-1', 0), 'the same key and attempt give the same marker');
});

test('B5: the marker is the first thing in the fallback text, and survives Slack escaping unchanged', () => {
  const message = buildSlackMessage({ lead: lead({ company: 'A&B <Co>' }), rep, key: 'sig-a&b', attempt: 0 });
  assert.ok(message.text.startsWith(message.marker), message.text);
});

test('B5: a huge payload is capped below Slack\'s documented limits and the marker is never cut', () => {
  const big = lead({ company: 'C'.repeat(50000), subject: 'S'.repeat(9000), body: 'B'.repeat(100000), citations: ['u'.repeat(9000)] });
  const message = buildSlackMessage({ lead: big, rep: { ...rep, id: 'r'.repeat(5000) }, key: 'k'.repeat(5000), attempt: 1, reassigned: { from: 'f'.repeat(5000), minutes: 30 } });
  assert.ok(message.text.length <= SLACK_TEXT_MAX, `fallback ${message.text.length} <= ${SLACK_TEXT_MAX}`);
  assert.ok(message.text.startsWith(message.marker));
  const fields = [];
  for (const block of message.blocks) {
    if (block.text) fields.push(block.text.text);
    for (const element of block.elements ?? []) fields.push(element.text);
  }
  for (const field of fields) assert.ok(field.length <= SLACK_SECTION_MAX, `block field ${field.length} <= ${SLACK_SECTION_MAX}`);
  assert.ok(fields.some((field) => field.startsWith(message.marker)), 'a block field starts with the marker');
});

test('B5: a post to key sig-a&b that may have landed is found by the live adapter, not posted again', async () => {
  const w = world();
  const stored = [];
  let posts = 0;
  const reply = (body) => ({ status: 200, text: async () => JSON.stringify(body) });
  const transport = async (url, options) => {
    if (url.endsWith('chat.postMessage')) {
      posts += 1;
      // Slack stores the text it was sent; history gives it back as sent.
      stored.push({ text: JSON.parse(options.body).text, ts: `1.${posts}` });
      if (posts === 1) throw new Error('socket hang up');
      return reply({ ok: true, ts: `1.${posts}` });
    }
    if (url.endsWith('conversations.open')) return reply({ ok: true, channel: { id: 'D1' } });
    if (url.includes('conversations.history')) return reply({ ok: true, messages: stored });
    throw new Error(`unexpected ${url}`);
  };
  const slack = createSlackAdapter({ transport, token: 'xoxb-test' });
  const event = { key: 'sig-a&b', lead: eventOf(1).lead };
  const once = () => tick({ events: [event], rotation: w.rotation, journal: Journal.open(w.path), hubspot: w.hubspot, slack, now: () => T0 });
  const first = await once();
  assert.equal(first.outcomes[0].status, 'SLACK_UNCONFIRMED');
  const second = await once();
  assert.equal(second.outcomes[0].status, 'ASSIGNED', JSON.stringify(second.outcomes));
  assert.equal(posts, 1, 'chat.postMessage was sent once');
});
