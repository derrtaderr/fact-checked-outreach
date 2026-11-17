// The Slack message. docs/INBOUND-SPEC.md, "Escaping and secrets".
//
// Payload text only ever appears inside plain_text objects, which Slack renders with no formatting,
// links or mentions, and in the notification fallback with &, < and > escaped and control characters
// made visible. The marker is what lets a crashed post be found again instead of posted twice.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSlackMessage, markerFor, SLACK_PLAIN_MAX } from '../src/inbound/message.mjs';

const lead = (overrides = {}) => ({
  lead_id: 'lead-abc',
  company: 'Acme Robotics',
  to: 'dana@acme.example.com',
  subject: 'Your pricing page',
  body: 'Hi Dana,\nSaw the four visits.',
  band: 'priority',
  play: 'executive-intro',
  score: 86,
  citations: ['https://directory.example.com/acme'],
  approved_by: 'cli-operator',
  ...overrides,
});
const rep = { id: 'rep-ana', slack_user_id: 'U0001', hubspot_owner_id: '1001' };

function allPlainText(blocks) {
  const texts = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node && typeof node === 'object') {
      if (node.type === 'plain_text' || node.type === 'mrkdwn') texts.push(node);
      Object.values(node).forEach(visit);
    }
  };
  visit(blocks);
  return texts;
}

test('the marker names the idempotency key and the attempt', () => {
  assert.equal(markerFor('sig-1', 0), 'signal-desk:sig-1:0');
});

test('the message goes to the rep, carries the brief, the checked draft and the marker', () => {
  const message = buildSlackMessage({ lead: lead(), rep, key: 'sig-1', attempt: 0, contactId: '501' });
  assert.equal(message.channel, 'U0001');
  assert.equal(message.marker, 'signal-desk:sig-1:0');
  const all = JSON.stringify(message.blocks);
  for (const expected of ['Acme Robotics', 'dana@acme.example.com', 'Your pricing page', 'Saw the four visits', 'priority', '86', 'https://directory.example.com/acme', 'signal-desk:sig-1:0']) {
    assert.ok(all.includes(expected), `blocks carry ${expected}`);
  }
  assert.match(message.text, /New inbound lead: Acme Robotics/);
  assert.match(all, /not been sent/i, 'the rep is told nothing went to the prospect');
});

test('every payload-derived value sits in a plain_text object, never in mrkdwn', () => {
  const hostile = lead({ company: 'ZZ-COMPANY', subject: 'ZZ-SUBJECT', body: 'ZZ-BODY', to: 'zz-to@x.example.com' });
  const message = buildSlackMessage({ lead: hostile, rep, key: 'sig-1', attempt: 0 });
  for (const node of allPlainText(message.blocks)) {
    if (node.type === 'mrkdwn') {
      assert.doesNotMatch(node.text, /ZZ-|zz-to/, `mrkdwn carries no payload text: ${node.text}`);
    }
  }
});

test('a hostile company name pings nobody and links nothing in the fallback text', () => {
  const message = buildSlackMessage({ lead: lead({ company: '<!channel> <https://evil.example|click> & co' }), rep, key: 'k', attempt: 0 });
  assert.doesNotMatch(message.text, /<!channel>|<https:/);
  assert.match(message.text, /&lt;!channel&gt; &lt;https:\/\/evil\.example\|click&gt; &amp; co/);
});

test('control characters in the payload are made visible, in the fallback and in plain_text', () => {
  const message = buildSlackMessage({ lead: lead({ company: 'Acme\u001b[2J\u202eX', body: 'line one\nline two\u0007' }), rep, key: 'k', attempt: 0 });
  assert.doesNotMatch(message.text, /\u001b|\u202e/);
  const texts = allPlainText(message.blocks).map((node) => node.text).join('\n');
  assert.doesNotMatch(texts, /[\u001b\u202e\u0007]/, 'no raw ESC, RLO or BEL in the blocks');
  assert.match(texts, /Acme\\x1b\[2J\\u202eX/, 'each one is shown as an escape the rep can see');
  assert.match(texts, /line one\nline two\\x07/, 'the draft keeps its own line breaks');
});

test('a very long draft is cut to what Slack accepts, and says it was cut', () => {
  const message = buildSlackMessage({ lead: lead({ body: 'x'.repeat(5000) }), rep, key: 'k', attempt: 0 });
  for (const node of allPlainText(message.blocks)) assert.ok(node.text.length <= SLACK_PLAIN_MAX);
  assert.match(JSON.stringify(message.blocks), /\(\d+ characters, first \d+ shown\)/);
});

test('a reassignment says so, naming the rep it came from and the window that passed', () => {
  const message = buildSlackMessage({
    lead: lead(), rep, key: 'k', attempt: 1, reassigned: { from: 'rep-ben', minutes: 30 },
  });
  assert.match(message.text, /Reassigned to you from rep-ben/);
  assert.match(message.text, /untouched for 30 minutes/);
  assert.equal(message.marker, 'signal-desk:k:1');
});
