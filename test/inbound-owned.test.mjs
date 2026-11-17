// An owner a person set is never overwritten by default. docs/INBOUND-SPEC.md, "An owner the tool did
// not write".
//
// Review pass 1, I1: assign PATCHed hubspot_owner_id on an existing contact without reading it, so a
// lead a person had already given to someone was silently taken and handed to the next rep.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHubSpotAdapter } from '../src/inbound/hubspot.mjs';
import { fakeHubSpot } from '../src/inbound/fakes.mjs';
import { parseRotationConfig } from '../src/inbound/rotation.mjs';
import { Journal } from '../src/inbound/journal.mjs';
import { fold } from '../src/inbound/engine.mjs';
import { eventOf, world, run, minutesAfter } from './helpers/inbound-world.mjs';

const OWNERS = ['o-ana', 'o-ben', 'o-cy', 'o-human'];
const humanOwned = () => fakeHubSpot({
  owners: OWNERS,
  snapshot: { nextId: 900, contacts: [{ contactId: '77', email: 'contact1@co1.example.com', ownerId: 'o-human', properties: {}, lastActivityAt: null }] },
});

test('I1: a contact a person already owns is not overwritten, nobody is told, and the rotation does not move', async () => {
  const w = world({ owners: OWNERS });
  w.hubspot = humanOwned();
  const result = await run(w, [eventOf(1)]);
  assert.equal(result.outcomes[0].status, 'ALREADY_OWNED');
  assert.match(result.outcomes[0].detail, /o-human/);
  assert.deepEqual(w.hubspot.contacts().map((c) => c.ownerId), ['o-human']);
  assert.equal(w.slack.posts().length, 0, 'nobody was told');
  assert.equal(fold(Journal.open(w.path).entries()).pointers['ae-round-robin'], undefined, 'the pointer did not move');

  const next = await run(w, [eventOf(1), eventOf(2)], minutesAfter(1));
  const two = next.outcomes.find((o) => o.key === 'sig-2');
  assert.equal(two.rep, 'ana', 'ana keeps her turn');
  assert.equal(w.hubspot.contacts().find((c) => c.contactId === '77').ownerId, 'o-human', 'still not overwritten on a later tick');
});

test('I1: overwrite_owner in the rotation file opts in to replacing an owner the tool did not write', async () => {
  const rotation = parseRotationConfig({
    response_minutes: 30,
    overwrite_owner: true,
    pools: { 'ae-round-robin': [{ id: 'ana', hubspot_owner_id: 'o-ana', slack_user_id: 'U-ana' }] },
  });
  assert.equal(rotation.overwrite_owner, true);
  const w = world({ rotation, owners: OWNERS });
  w.hubspot = humanOwned();
  const result = await run(w, [eventOf(1)]);
  assert.equal(result.outcomes[0].status, 'ASSIGNED');
  assert.deepEqual(w.hubspot.contacts().map((c) => c.ownerId), ['o-ana']);
});

test('I1: overwrite_owner must be true or false', () => {
  assert.throws(() => parseRotationConfig({ response_minutes: 30, overwrite_owner: 'yes', pools: {} }), { code: 'ROTATION_CONFIG_INVALID' });
});

test('I1: a reassignment still replaces the owner this tool wrote', async () => {
  const w = world();
  await run(w, [eventOf(1)]);
  const moved = await run(w, [], minutesAfter(31));
  assert.equal(moved.outcomes[0].status, 'REASSIGNED');
  assert.deepEqual(w.hubspot.contacts().map((c) => c.ownerId), ['o-ben']);
});

// The live adapter reads before it writes.
const reply = (status, body) => ({ status, text: async () => JSON.stringify(body) });
function scripted(answers) {
  const calls = [];
  const transport = async (url, options) => {
    calls.push(`${options.method} ${new URL(url).pathname}`);
    return answers.shift();
  };
  return { calls, hubspot: createHubSpotAdapter({ transport, token: 't' }) };
}

test('I1: the live adapter reads the contact first and never PATCHes an owner it did not write', async () => {
  const { calls, hubspot } = scripted([reply(200, { id: '77', properties: { hubspot_owner_id: '999' } })]);
  const result = await hubspot.assign({ email: 'a@b.test', ownerId: '1001' });
  assert.equal(result.refused, 'ALREADY_OWNED');
  assert.equal(result.ownerId, '999');
  assert.deepEqual(calls.map((c) => c.split(' ')[0]), ['GET']);
});

test('I1: the live adapter writes an owner on a contact with none, or one this tool wrote', async () => {
  for (const [existing, mayReplace] of [[null, []], ['', []], ['1000', ['1000']]]) {
    const { calls, hubspot } = scripted([reply(200, { id: '77', properties: { hubspot_owner_id: existing } }), reply(200, { id: '77' })]);
    const result = await hubspot.assign({ email: 'a@b.test', ownerId: '1001', mayReplace });
    assert.deepEqual(result, { contactId: '77', created: false });
    assert.deepEqual(calls.map((c) => c.split(' ')[0]), ['GET', 'PATCH']);
  }
});

test('I1: --plan says the contact is read first and an owner the tool did not write is left alone', async () => {
  const { main } = await import('../src/cli.mjs');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const cwd = mkdtempSync(join(tmpdir(), 'signal-desk-owned-'));
  const lines = [];
  const cli = (argv) => main({ argv, cwd, env: {}, out: (l) => lines.push(l), err: (l) => lines.push(l), now: () => '2026-03-01T09:00:00.000Z' });
  await cli(['run']);
  writeFileSync(join(cwd, 'inbound.json'), JSON.stringify({ response_minutes: 30, pools: { 'ae-round-robin': [{ id: 'ana', hubspot_owner_id: '1001', slack_user_id: 'U0001' }] } }));
  lines.length = 0;
  assert.equal(await cli(['inbound', '--live', '--plan']), 0);
  const out = lines.join('\n');
  assert.match(out, /GET https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/contacts\/dana%40acme\.test\?idProperty=email/);
  assert.match(out, /ALREADY_OWNED/);
  assert.match(out, /overwrite_owner/);
});
