// The response clock. docs/INBOUND-SPEC.md, "The clock".
//
// Driven by the instant each tick is handed, so "45 minutes later" is a value, not a wait. Untouched
// is read from HubSpot: the owner this attempt wrote is still the owner, and no activity is logged at
// or after the instant it was written.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Journal } from '../src/inbound/journal.mjs';
import { fold } from '../src/inbound/engine.mjs';
import { T0, minutesAfter, rotationOf, eventOf, world, run } from './helpers/inbound-world.mjs';
import { markerFor } from '../src/inbound/message.mjs';

const only = (report) => {
  assert.equal(report.outcomes.length, 1);
  return report.outcomes[0];
};

test('inside the window the clock runs, and HubSpot is not read', async () => {
  const w = world();
  await run(w, [eventOf(1)]);
  let reads = 0;
  const read = w.hubspot.read;
  w.hubspot.read = async (args) => { reads += 1; return read(args); };
  const report = await run(w, [], minutesAfter(29));
  assert.equal(only(report).status, 'CLOCK_RUNNING');
  assert.match(only(report).detail, /1 minute\(s\) left/);
  assert.equal(reads, 0);
});

test('past the window and untouched: reassigned to the next rep, owner rewritten, new rep told why', async () => {
  const w = world();
  await run(w, [eventOf(1)]);
  const report = await run(w, [], minutesAfter(31));

  assert.equal(only(report).status, 'REASSIGNED');
  assert.equal(only(report).rep, 'ben');
  assert.equal(w.hubspot.contacts()[0].ownerId, 'o-ben');
  const posts = w.slack.posts();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].channel, 'U-ben');
  assert.equal(posts[1].marker, markerFor('sig-1', 1));
  assert.match(posts[1].text, /Reassigned to you from ana: the lead was untouched for 30 minutes/);
  assert.equal(fold(Journal.open(w.path).entries()).pointers['ae-round-robin'], 'ben', 'a reassignment takes a turn');
});

test('activity logged after the owner was written stops the clock for good', async () => {
  const w = world();
  await run(w, [eventOf(1)]);
  w.hubspot.logActivity('contact1@co1.example.com', minutesAfter(5));
  assert.equal(only(await run(w, [], minutesAfter(31))).status, 'TOUCHED');
  const after = readFileSync(w.path, 'utf8');
  assert.deepEqual(await run(w, [], minutesAfter(500)).then((r) => r.outcomes), []);
  assert.equal(readFileSync(w.path, 'utf8'), after);
  assert.equal(w.hubspot.contacts()[0].ownerId, 'o-ana');
});

test('activity from before the assignment does not count as touched', async () => {
  const w = world();
  await run(w, [eventOf(1)]);
  w.hubspot.logActivity('contact1@co1.example.com', minutesAfter(-60));
  assert.equal(only(await run(w, [], minutesAfter(31))).status, 'REASSIGNED');
});

test('a person who changed the owner in HubSpot wins: the clock stops and nothing is reassigned', async () => {
  const w = world();
  await run(w, [eventOf(1)]);
  w.hubspot.setOwner('contact1@co1.example.com', 'o-dee');
  const outcome = only(await run(w, [], minutesAfter(31)));
  assert.equal(outcome.status, 'OWNER_CHANGED');
  assert.equal(w.hubspot.contacts()[0].ownerId, 'o-dee');
  assert.equal(w.slack.posts().length, 1);
});

test('when every rep has had the lead untouched, it parks for a human as NO_REP_RESPONDED', async () => {
  const w = world({ rotation: rotationOf({ 'ae-round-robin': ['ana', 'ben'] }) });
  await run(w, [eventOf(1)]);
  assert.equal(only(await run(w, [], minutesAfter(31))).status, 'REASSIGNED');
  const outcome = only(await run(w, [], minutesAfter(62)));
  assert.equal(outcome.status, 'NO_REP_RESPONDED');
  assert.match(outcome.detail, /ana, ben/);
  assert.equal(w.hubspot.contacts()[0].ownerId, 'o-ben', 'the last owner stays; nobody is left without one');
  assert.deepEqual((await run(w, [], minutesAfter(500))).outcomes, []);
});

test('the window restarts when the new rep is told, not when the lead first arrived', async () => {
  const w = world();
  await run(w, [eventOf(1)]);
  await run(w, [], minutesAfter(31));
  assert.equal(only(await run(w, [], minutesAfter(60))).status, 'CLOCK_RUNNING');
  assert.equal(only(await run(w, [], minutesAfter(62))).status, 'REASSIGNED');
  assert.equal(w.hubspot.contacts()[0].ownerId, 'o-cy');
});

test('an untried rep who is away holds the reassignment as REASSIGN_WAITING rather than parking it', async () => {
  const rotation = rotationOf({ 'ae-round-robin': ['ana', { id: 'ben', hubspot_owner_id: 'o-ben', slack_user_id: 'U-ben', away: true }] });
  const w = world({ rotation });
  await run(w, [eventOf(1)]);
  const outcome = only(await run(w, [], minutesAfter(31)));
  assert.equal(outcome.status, 'REASSIGN_WAITING');
  assert.match(outcome.detail, /ben: away/);
  assert.equal(w.hubspot.contacts()[0].ownerId, 'o-ana');
});

test('HubSpot unreadable at a clock check: nothing is reassigned on a guess', async () => {
  const w = world();
  await run(w, [eventOf(1)]);
  w.hubspot.failNext('HUBSPOT_UNAVAILABLE');
  const outcome = only(await run(w, [], minutesAfter(31)));
  assert.equal(outcome.status, 'CLOCK_CHECK_FAILED');
  assert.equal(w.hubspot.contacts()[0].ownerId, 'o-ana');
  assert.equal(w.slack.posts().length, 1);
});

test('replayable: the same events at the same instants write byte-identical journals', async () => {
  const script = async () => {
    const w = world();
    await run(w, [eventOf(1), eventOf(2)], T0);
    w.hubspot.logActivity('contact2@co2.example.com', minutesAfter(3));
    await run(w, [], minutesAfter(31));
    await run(w, [eventOf(3)], minutesAfter(40));
    return readFileSync(w.path, 'utf8');
  };
  assert.equal(await script(), await script());
});
