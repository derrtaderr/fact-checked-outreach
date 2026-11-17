// Crash recovery. docs/INBOUND-SPEC.md, "The journal, and why a crash cannot skip, double-assign or
// double-post".
//
// A crash is simulated the only honest way: the Nth journal append fails, so every side effect before
// it happened and nothing after it did. Then a fresh process (a new Journal on the same file, the same
// HubSpot and Slack) runs again. This is done at EVERY append point of a three-lead run, and once more
// with the append tearing its line in half.

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

import { Journal } from '../src/inbound/journal.mjs';
import { fold } from '../src/inbound/engine.mjs';
import { eventOf, world, run } from './helpers/inbound-world.mjs';

const EVENTS = [eventOf(1), eventOf(2), eventOf(3)];

class SimulatedCrash extends Error {}

function crashingAt(n, { torn = false } = {}) {
  let count = 0;
  return {
    appendLine(path, text) {
      count += 1;
      if (count === n) {
        if (torn) appendFileSync(path, text.slice(0, Math.floor(text.length / 2)));
        throw new SimulatedCrash(`crash at append ${n}`);
      }
      appendFileSync(path, text);
    },
  };
}

function assertSettled(w, label) {
  assert.deepEqual(
    w.hubspot.contacts().map((c) => [c.email, c.ownerId]),
    [
      ['contact1@co1.example.com', 'o-ana'],
      ['contact2@co2.example.com', 'o-ben'],
      ['contact3@co3.example.com', 'o-cy'],
    ],
    `${label}: one contact per lead, each owned by the rep whose turn it was, none skipped or doubled`,
  );
  assert.deepEqual(
    w.slack.posts().map((p) => [p.channel, p.marker]),
    [
      ['U-ana', 'signal-desk:sig-1:0'],
      ['U-ben', 'signal-desk:sig-2:0'],
      ['U-cy', 'signal-desk:sig-3:0'],
    ],
    `${label}: every rep told exactly once`,
  );
  assert.equal(fold(Journal.open(w.path).entries()).pointers['ae-round-robin'], 'cy', `${label}: pointer`);
}

test('a clean run of three leads appends four lines per lead', async () => {
  const w = world();
  await run(w, EVENTS);
  assert.equal(Journal.open(w.path).entries().length, 12);
  assertSettled(w, 'clean');
});

for (const torn of [false, true]) {
  test(`a crash at any of the 12 appends${torn ? ', tearing the line,' : ''} recovers on the next run with no skip and no double`, async () => {
    for (let n = 1; n <= 12; n += 1) {
      const w = world();
      await assert.rejects(run(w, EVENTS, undefined, crashingAt(n, { torn })), SimulatedCrash);
      const recovered = await run(w, EVENTS);
      if (torn) assert.match(recovered.repaired ?? '', /torn final line/, `crash ${n}: the torn line is reported`);
      assertSettled(w, `crash at append ${n}${torn ? ' (torn)' : ''}`);
    }
  });
}

test('a crash between the HubSpot write and its journal line rewrites the same owner, never a second contact', async () => {
  const w = world();
  await assert.rejects(run(w, [eventOf(1)], undefined, crashingAt(2)), SimulatedCrash);
  assert.equal(w.hubspot.contacts().length, 1, 'HubSpot was written before the crash');
  assert.equal(w.slack.posts().length, 0, 'and nobody was told');
  await run(w, [eventOf(1)]);
  assert.equal(w.hubspot.contacts().length, 1);
  assert.equal(w.slack.posts().length, 1);
});

test('a post that landed but whose result line was lost is found by its marker, not posted again', async () => {
  const w = world();
  await assert.rejects(run(w, [eventOf(1)], undefined, crashingAt(4)), SimulatedCrash);
  assert.equal(w.slack.posts().length, 1);
  const report = await run(w, [eventOf(1)]);
  assert.equal(w.slack.posts().length, 1);
  assert.match(report.outcomes[0].detail, /found, not repeated/);
});

test('a timeout after send is resolved on the next run by asking Slack, with one post in the end', async () => {
  const w = world();
  w.slack.ambiguousNext();
  const first = await run(w, [eventOf(1)]);
  assert.equal(first.outcomes[0].status, 'SLACK_UNCONFIRMED');
  await run(w, []);
  assert.equal(w.slack.posts().length, 1);
  assert.ok(Journal.open(w.path).entries().some((e) => e.type === 'slack_posted' && e.found === true));
});

test('when Slack cannot be asked, an unconfirmed post stays unconfirmed and is never posted twice', async () => {
  const w = world({ searchable: false });
  w.slack.ambiguousNext();
  await run(w, [eventOf(1)]);
  const second = await run(w, []);
  const third = await run(w, []);
  assert.equal(second.outcomes[0].status, 'SLACK_UNCONFIRMED');
  assert.equal(third.outcomes[0].status, 'SLACK_UNCONFIRMED');
  assert.match(third.outcomes[0].detail, /Nothing was posted again/);
  assert.equal(w.slack.posts().length, 1);
  assert.equal(w.hubspot.contacts()[0].ownerId, 'o-ana', 'the lead still has its owner');
});

test('a crash at the first claim leaves the pointer where it was, so the same rep gets the lead', async () => {
  const w = world();
  await run(w, [eventOf(1)]);
  await assert.rejects(run(w, [eventOf(2)], undefined, crashingAt(1)), SimulatedCrash);
  await run(w, [eventOf(2)]);
  assert.equal(w.hubspot.contacts()[1].ownerId, 'o-ben');
});
