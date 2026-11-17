// A claim released because its rep left the pool, when nobody can be picked next, leaves the lead with
// no working owner. docs/INBOUND-SPEC.md, "Exit codes".
//
// Review pass 2, N1: reclaim answered REASSIGN_WAITING, which is not exit 4, so a lead whose HubSpot
// owner had never been told (or that had no contact at all) waited at exit 0 on every tick for good.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_A_PERSON } from '../src/inbound/verb.mjs';
import { planCalls } from '../src/inbound/plan.mjs';
import { Journal } from '../src/inbound/journal.mjs';
import { eventOf, rotationOf, world, run, minutesAfter } from './helpers/inbound-world.mjs';

const away = (id) => ({ id, hubspot_owner_id: `o-${id}`, slack_user_id: `U-${id}`, away: true });

test('N1: a released claim with nobody eligible next needs a person, on every tick and in the plan, and resumes when a rep is free', async () => {
  // probe6 section 5: HubSpot down, so the lead is CRM_PENDING with ana; ana is removed, ben is away.
  const w = world({ rotation: rotationOf({ 'ae-round-robin': ['ana', away('ben')] }) });
  w.hubspot.failNext('HUBSPOT_UNAVAILABLE');
  assert.equal((await run(w, [eventOf(1)])).outcomes[0].status, 'CRM_PENDING');

  w.rotation = rotationOf({ 'ae-round-robin': [away('ben')] });
  for (const at of [minutesAfter(1), minutesAfter(600)]) {
    const [outcome] = (await run(w, [], at)).outcomes;
    assert.ok(NEEDS_A_PERSON.includes(outcome.status), `${outcome.status} must need a person: ${outcome.detail}`);
    assert.equal(outcome.code, 'NO_ELIGIBLE_REP');
    assert.equal(outcome.rep, undefined, 'nobody holds it');
  }
  const planned = await planCalls({ events: [], rotation: w.rotation, journal: Journal.open(w.path, { readOnly: true }), at: minutesAfter(601) });
  assert.ok(NEEDS_A_PERSON.includes(planned.outcomes[0].status), 'the plan lists it too');
  assert.equal(w.hubspot.contacts().length, 0);

  w.rotation = rotationOf({ 'ae-round-robin': ['ben'] });
  const back = (await run(w, [], minutesAfter(602))).outcomes[0];
  assert.equal(back.status, 'ASSIGNED');
  assert.equal(back.rep, 'ben');
});

test('N1: a released claim whose remaining reps have all had the lead parks as NO_REP_RESPONDED', async () => {
  // probe7 A: ana is told and leaves it untouched; it goes to ben, whose Slack rejects; ben is removed.
  const w = world({ rotation: rotationOf({ 'ae-round-robin': ['ana', 'ben'] }) });
  await run(w, [eventOf(1)]);
  w.slack.rejectNext('user_not_found');
  assert.equal((await run(w, [], minutesAfter(31))).outcomes[0].status, 'SLACK_PENDING');

  w.rotation = rotationOf({ 'ae-round-robin': ['ana'] });
  const parked = (await run(w, [], minutesAfter(32))).outcomes[0];
  assert.equal(parked.status, 'NO_REP_RESPONDED', parked.detail);
  assert.ok(Journal.open(w.path).entries().some((e) => e.type === 'exhausted'), 'journaled as exhausted, as the clock does');

  const again = (await run(w, [], minutesAfter(2000))).outcomes[0];
  assert.equal(again.status, 'NO_REP_RESPONDED', 'listed on every tick until a person acts');
  assert.equal(w.slack.posts().length, 1, 'nobody else was told');
});

test('N1: a parked lead whose last attempt never wrote an owner is read against the owner that was written', async () => {
  // ana told and untouched, reassigned to ben, HubSpot down for ben's write; ben is removed.
  const w = world({ rotation: rotationOf({ 'ae-round-robin': ['ana', 'ben'] }) });
  await run(w, [eventOf(1)]);
  const assign = w.hubspot.assign;
  w.hubspot.assign = async (args) => { w.hubspot.assign = assign; w.hubspot.failNext('HUBSPOT_UNAVAILABLE'); return assign(args); };
  assert.equal((await run(w, [], minutesAfter(31))).outcomes[0].status, 'CRM_PENDING');

  w.rotation = rotationOf({ 'ae-round-robin': ['ana'] });
  const parked = (await run(w, [], minutesAfter(32))).outcomes[0];
  assert.equal(parked.status, 'NO_REP_RESPONDED');
  assert.equal(parked.rep, 'ana', 'parked with the rep whose owner HubSpot holds');
  const again = (await run(w, [], minutesAfter(33))).outcomes[0];
  assert.equal(again.status, 'NO_REP_RESPONDED', again.detail);
  assert.equal(again.rep, 'ana');
});

test('N1 unchanged: a lead still with its told rep waits as REASSIGN_WAITING, exit 0', async () => {
  const w = world({ rotation: rotationOf({ 'ae-round-robin': ['ana', away('ben')] }) });
  await run(w, [eventOf(1)]);
  const outcome = (await run(w, [], minutesAfter(31))).outcomes[0];
  assert.equal(outcome.status, 'REASSIGN_WAITING');
  assert.equal(outcome.rep, 'ana');
  assert.ok(!NEEDS_A_PERSON.includes(outcome.status));
});
