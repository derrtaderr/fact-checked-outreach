// The inbound engine: assignment, idempotency and recoverable failures. docs/INBOUND-SPEC.md.
//
// Every test runs against the fakes and a journal on disk, so "re-run" means what it means for an
// operator: a new process reading the same journal file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Journal } from '../src/inbound/journal.mjs';
import { T0, rotationOf, eventOf, world, run } from './helpers/inbound-world.mjs';

const statusOf = (report, key) => report.outcomes.find((o) => o.key === key)?.status;

test('two new leads go to the first two reps in turn: owner written, rep told', async () => {
  const w = world();
  const report = await run(w, [eventOf(1), eventOf(2)]);

  assert.equal(statusOf(report, 'sig-1'), 'ASSIGNED');
  assert.equal(statusOf(report, 'sig-2'), 'ASSIGNED');
  assert.deepEqual(w.hubspot.contacts().map((c) => [c.email, c.ownerId]), [
    ['contact1@co1.example.com', 'o-ana'],
    ['contact2@co2.example.com', 'o-ben'],
  ]);
  assert.deepEqual(w.slack.posts().map((p) => [p.channel, p.marker]), [
    ['U-ana', 'signal-desk:sig-1:0'],
    ['U-ben', 'signal-desk:sig-2:0'],
  ]);
});

test('the pointer persists across runs: the next run continues with the next rep', async () => {
  const w = world();
  await run(w, [eventOf(1)]);
  await run(w, [eventOf(2)]);
  await run(w, [eventOf(3), eventOf(4)]);
  assert.deepEqual(w.hubspot.contacts().map((c) => c.ownerId), ['o-ana', 'o-ben', 'o-cy', 'o-ana']);
});

test('a re-run or a re-delivered event assigns nothing twice and moves no pointer', async () => {
  const w = world();
  await run(w, [eventOf(1)]);
  const before = readFileSync(w.path, 'utf8');

  const again = await run(w, [eventOf(1)]);
  assert.equal(statusOf(again, 'sig-1'), 'CLOCK_RUNNING');
  assert.match(again.outcomes[0].detail, /already assigned to ana/);
  assert.equal(readFileSync(w.path, 'utf8'), before, 'not one journal line was written');
  assert.equal(w.slack.posts().length, 1);
  assert.equal(w.hubspot.contacts().length, 1);

  await run(w, [eventOf(2)]);
  assert.equal(w.hubspot.contacts()[1].ownerId, 'o-ben', 'the re-delivery did not take a turn');
});

test('the same lead under a new signal id is skipped as LEAD_ALREADY_ASSIGNED and takes no turn', async () => {
  const w = world();
  await run(w, [eventOf(1)]);
  const dup = eventOf(9, { lead_id: 'lead-1' });
  const report = await run(w, [dup]);
  assert.equal(statusOf(report, 'sig-9'), 'LEAD_ALREADY_ASSIGNED');
  assert.equal(w.slack.posts().length, 1);
  await run(w, [eventOf(2)]);
  assert.equal(w.hubspot.contacts()[1].ownerId, 'o-ben');
});

test('an empty rotation refuses ROTATION_EMPTY: nobody assigned, nothing called, nothing journaled', async () => {
  const w = world({ rotation: rotationOf({ 'ae-round-robin': [] }) });
  const report = await run(w, [eventOf(1)]);
  assert.equal(statusOf(report, 'sig-1'), 'REFUSED');
  assert.equal(report.outcomes[0].code, 'ROTATION_EMPTY');
  assert.equal(w.hubspot.contacts().length, 0);
  assert.equal(w.slack.posts().length, 0);
  assert.equal(Journal.open(w.path).entries().length, 0);
});

test('every rep away refuses NO_ELIGIBLE_REP, and a lead with no pool refuses NO_ROTATION_FOR_POOL', async () => {
  const away = (id) => ({ id, hubspot_owner_id: `o-${id}`, slack_user_id: `U-${id}`, away: true });
  const w = world({ rotation: rotationOf({ 'ae-round-robin': [away('ana'), away('ben')] }) });
  const report = await run(w, [eventOf(1), eventOf(2, { pool: 'sdr-queue' })]);
  assert.equal(report.outcomes.find((o) => o.key === 'sig-1').code, 'NO_ELIGIBLE_REP');
  assert.equal(report.outcomes.find((o) => o.key === 'sig-2').code, 'NO_ROTATION_FOR_POOL');
  assert.equal(w.hubspot.contacts().length, 0);
});

test('a lead with no email address is refused before any rep is picked', async () => {
  const w = world();
  const report = await run(w, [eventOf(1, { to: '' })]);
  assert.equal(report.outcomes[0].code, 'LEAD_HAS_NO_EMAIL');
  assert.equal(Journal.open(w.path).entries().length, 0);
});

test('HubSpot down: CRM_PENDING, nobody is told, and the next run writes the SAME rep then posts', async () => {
  const w = world();
  w.hubspot.failNext('HUBSPOT_UNAVAILABLE');
  const first = await run(w, [eventOf(1)]);
  assert.equal(statusOf(first, 'sig-1'), 'CRM_PENDING');
  assert.equal(first.outcomes[0].code, 'HUBSPOT_UNAVAILABLE');
  assert.equal(w.slack.posts().length, 0, 'a rep is never told about a lead they do not own');

  const second = await run(w, [eventOf(1), eventOf(2)]);
  assert.equal(statusOf(second, 'sig-1'), 'ASSIGNED');
  assert.deepEqual(w.hubspot.contacts().map((c) => c.ownerId), ['o-ana', 'o-ben']);
  assert.deepEqual(w.slack.posts().map((p) => p.channel), ['U-ana', 'U-ben']);
});

test('Slack rejects the post: SLACK_PENDING, and the next run posts exactly once', async () => {
  const w = world();
  w.slack.rejectNext('channel_not_found');
  const first = await run(w, [eventOf(1)]);
  assert.equal(statusOf(first, 'sig-1'), 'SLACK_PENDING');
  assert.equal(w.hubspot.contacts()[0].ownerId, 'o-ana', 'the owner is already written');
  await run(w, []);
  await run(w, []);
  assert.equal(w.slack.posts().length, 1);
});
