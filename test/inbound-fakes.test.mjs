// The fake HubSpot and fake Slack. docs/INBOUND-SPEC.md, "Adapters".
//
// Fixture mode runs on these, and every engine test does. They behave the way the live portal was
// observed to behave on 2026-11-16: update by email, create on a miss, one contact per email, an
// unknown owner refused. If a fake is kinder than the real service, the tests above it prove nothing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeHubSpot, fakeSlack } from '../src/inbound/fakes.mjs';
import { InboundAdapterError } from '../src/inbound/errors.mjs';

test('assign creates a contact once per email and updates its owner after that', async () => {
  const hubspot = fakeHubSpot({ owners: ['1001', '1002'] });
  const first = await hubspot.assign({ email: 'a@x.example.com', ownerId: '1001', properties: { company: 'X' } });
  const again = await hubspot.assign({ email: 'A@x.example.com', ownerId: '1002', properties: {} });
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.contactId, first.contactId);
  assert.equal(hubspot.contacts().length, 1);
  assert.equal((await hubspot.read({ email: 'a@x.example.com' })).ownerId, '1002');
});

test('an owner the portal does not have is refused, as HubSpot refuses INVALID_OWNER_ID', async () => {
  const hubspot = fakeHubSpot({ owners: ['1001'] });
  await assert.rejects(hubspot.assign({ email: 'a@x.example.com', ownerId: '999' }), (error) => {
    assert.ok(error instanceof InboundAdapterError);
    assert.equal(error.code, 'HUBSPOT_INVALID_OWNER');
    return true;
  });
  assert.equal(hubspot.contacts().length, 0);
});

test('read returns null for an unknown email, and reports logged activity and a human owner change', async () => {
  const hubspot = fakeHubSpot({ owners: ['1001', '1002'] });
  assert.equal(await hubspot.read({ email: 'nobody@x.example.com' }), null);
  await hubspot.assign({ email: 'a@x.example.com', ownerId: '1001' });
  hubspot.logActivity('a@x.example.com', '2026-03-01T09:10:00.000Z');
  hubspot.setOwner('a@x.example.com', '1002');
  const read = await hubspot.read({ email: 'a@x.example.com' });
  assert.equal(read.lastActivityAt, '2026-03-01T09:10:00.000Z');
  assert.equal(read.ownerId, '1002');
});

test('a scripted HubSpot failure is thrown once, with its code, and changes nothing', async () => {
  const hubspot = fakeHubSpot({ owners: ['1001'] });
  hubspot.failNext('HUBSPOT_UNAVAILABLE');
  await assert.rejects(hubspot.assign({ email: 'a@x.example.com', ownerId: '1001' }), { code: 'HUBSPOT_UNAVAILABLE' });
  assert.equal(hubspot.contacts().length, 0);
  await hubspot.assign({ email: 'a@x.example.com', ownerId: '1001' });
  assert.equal(hubspot.contacts().length, 1);
});

test('the fake HubSpot state round-trips through a snapshot, so fixture mode can persist it', async () => {
  const hubspot = fakeHubSpot({ owners: ['1001'] });
  await hubspot.assign({ email: 'a@x.example.com', ownerId: '1001' });
  const restored = fakeHubSpot({ owners: ['1001'], snapshot: hubspot.snapshot() });
  assert.equal((await restored.read({ email: 'a@x.example.com' })).ownerId, '1001');
});

test('slack post records the message and find locates it by marker', async () => {
  const slack = fakeSlack();
  const { ts } = await slack.post({ channel: 'U1', text: 't', blocks: [], marker: 'signal-desk:k:0' });
  assert.equal(slack.posts().length, 1);
  assert.deepEqual(await slack.find({ channel: 'U1', marker: 'signal-desk:k:0' }), { ts });
  assert.equal(await slack.find({ channel: 'U1', marker: 'signal-desk:k:1' }), null);
});

test('an ambiguous post lands the message and still throws, which is what a timeout after send looks like', async () => {
  const slack = fakeSlack();
  slack.ambiguousNext();
  await assert.rejects(slack.post({ channel: 'U1', text: 't', blocks: [], marker: 'm' }), (error) => {
    assert.equal(error.code, 'SLACK_UNREACHABLE');
    assert.equal(error.ambiguous, true);
    return true;
  });
  assert.equal(slack.posts().length, 1);
});

test('a rejected post lands nothing and is not ambiguous', async () => {
  const slack = fakeSlack();
  slack.rejectNext('channel_not_found');
  await assert.rejects(slack.post({ channel: 'U1', text: 't', blocks: [], marker: 'm' }), (error) => {
    assert.equal(error.code, 'SLACK_REJECTED');
    assert.equal(error.ambiguous, false);
    return true;
  });
  assert.equal(slack.posts().length, 0);
});

test('a Slack that cannot be searched says so instead of answering not found', async () => {
  const slack = fakeSlack({ searchable: false });
  await assert.rejects(slack.find({ channel: 'U1', marker: 'm' }), { code: 'SLACK_UNSEARCHABLE' });
});
