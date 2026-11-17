// A retry reads the rep's ids from the rotation as it is now. docs/INBOUND-SPEC.md, "The journal".
//
// Review pass 1, B3: complete() reused the owner id and Slack id frozen into the claim, so a typo in
// the rotation file left the lead ownerless (or owned with the rep never told) forever, even after
// the operator fixed the file, while the output promised that the next run would work.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Journal } from '../src/inbound/journal.mjs';
import { eventOf, rotationOf, world, run, minutesAfter } from './helpers/inbound-world.mjs';

const typo = rotationOf({ 'ae-round-robin': [{ id: 'ana', hubspot_owner_id: 'TYPO', slack_user_id: 'U-ana' }, 'ben', 'cy'] });
const fixed = rotationOf({ 'ae-round-robin': ['ana', 'ben', 'cy'] });

test('B3: a wrong owner id says the retry cannot work until the file is fixed, and the fix is picked up', async () => {
  const w = world({ rotation: typo });
  const first = await run(w, [eventOf(1)]);
  assert.equal(first.outcomes[0].status, 'CRM_PENDING');
  assert.equal(first.outcomes[0].code, 'HUBSPOT_INVALID_OWNER');
  assert.match(first.outcomes[0].detail, /hubspot_owner_id/);
  assert.match(first.outcomes[0].detail, /rotation file/);
  assert.doesNotMatch(first.outcomes[0].detail, /the next run writes the owner again/);

  const same = await run(w, [eventOf(1)], minutesAfter(5));
  assert.equal(same.outcomes[0].status, 'CRM_PENDING', 'unchanged file, same failure');

  w.rotation = fixed;
  const healed = await run(w, [eventOf(1)], minutesAfter(10));
  assert.equal(healed.outcomes[0].status, 'ASSIGNED', JSON.stringify(healed.outcomes));
  assert.equal(healed.outcomes[0].rep, 'ana', 'the same rep keeps the turn');
  assert.deepEqual(w.hubspot.contacts().map((c) => c.ownerId), ['o-ana']);
  assert.deepEqual(w.slack.posts().map((p) => p.channel), ['U-ana']);
});

test('B3: after the owner id is fixed, the clock compares HubSpot with the owner actually written', async () => {
  const w = world({ rotation: typo });
  await run(w, [eventOf(1)]);
  w.rotation = fixed;
  await run(w, [eventOf(1)], minutesAfter(1));
  const clock = await run(w, [], minutesAfter(40));
  assert.equal(clock.outcomes[0].status, 'REASSIGNED', JSON.stringify(clock.outcomes));
  assert.equal(clock.outcomes[0].rep, 'ben');
});

test('B3: a Slack id Slack refused is read again from the fixed file, and the rep is told there', async () => {
  const w = world();
  w.slack.rejectNext('channel_not_found');
  const first = await run(w, [eventOf(1)]);
  assert.equal(first.outcomes[0].status, 'SLACK_PENDING');
  assert.match(first.outcomes[0].detail, /slack_user_id/);
  w.rotation = rotationOf({ 'ae-round-robin': [{ id: 'ana', hubspot_owner_id: 'o-ana', slack_user_id: 'U-FIXED' }, 'ben', 'cy'] });
  const second = await run(w, [eventOf(1)], minutesAfter(5));
  assert.equal(second.outcomes[0].status, 'ASSIGNED');
  assert.deepEqual(w.slack.posts().map((p) => p.channel), ['U-FIXED']);
});

test('B3: a claimed rep removed from the rotation is released with a journaled reason and the lead assigned again', async () => {
  const w = world({ rotation: typo });
  await run(w, [eventOf(1)]);
  w.rotation = rotationOf({ 'ae-round-robin': ['ben', 'cy'] });
  const again = await run(w, [eventOf(1)], minutesAfter(5));
  assert.equal(again.outcomes[0].status, 'ASSIGNED', JSON.stringify(again.outcomes));
  assert.equal(again.outcomes[0].rep, 'ben');
  assert.match(again.outcomes[0].detail, /ana/);
  const released = Journal.open(w.path).entries().filter((e) => e.type === 'released');
  assert.equal(released.length, 1);
  assert.match(released[0].reason, /ana/);
  assert.deepEqual(w.hubspot.contacts().map((c) => c.ownerId), ['o-ben']);
  assert.deepEqual(w.slack.posts().map((p) => p.channel), ['U-ben']);
  // ben's message is not a "reassigned because untouched" message: ana never had the lead.
  assert.doesNotMatch(w.slack.posts()[0].blocks[0].text.text, /untouched/);
});

test('B3: a released lead with nobody to take it says so, and the next tick assigns it when someone can', async () => {
  const w = world({ rotation: typo });
  await run(w, [eventOf(1)]);
  w.rotation = rotationOf({ 'ae-round-robin': [{ id: 'ben', hubspot_owner_id: 'o-ben', slack_user_id: 'U-ben', away: true }] });
  const stuck = await run(w, [eventOf(1)], minutesAfter(5));
  assert.equal(stuck.outcomes[0].code, 'NO_ELIGIBLE_REP');
  assert.doesNotMatch(stuck.outcomes[0].detail, /keeps this turn/);
  w.rotation = rotationOf({ 'ae-round-robin': ['ben'] });
  const done = await run(w, [eventOf(1)], minutesAfter(10));
  assert.equal(done.outcomes[0].status, 'ASSIGNED');
  assert.equal(done.outcomes[0].rep, 'ben');
  assert.equal(Journal.open(w.path).entries().filter((e) => e.type === 'released').length, 1, 'released once');
});
