// The live HubSpot adapter, against a fake transport. docs/INBOUND-SPEC.md, "Adapters".
//
// The fake transport answers the way the developer test portal answered on 2026-11-16: update by email
// 404s for an unknown contact, create 201s, a duplicate create 409s, an unknown owner 400s with
// INVALID_OWNER_ID. No socket is opened; test/no-network.test.mjs keeps it that way.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHubSpotAdapter, HUBSPOT_BASE } from '../src/inbound/hubspot.mjs';
import { secretScrubber } from '../src/live/keys.mjs';

const TOKEN = 'pat-na2-canary-DO-NOT-LOG-77c1';

function response(status, body) {
  return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

function transport(script) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined, headers: options.headers });
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

const adapter = (fake) => createHubSpotAdapter({ transport: fake, token: TOKEN, scrub: secretScrubber([TOKEN]) });
const path = (url) => url.slice(HUBSPOT_BASE.length);

test('the adapter refuses to be built without a transport or a token', () => {
  assert.throws(() => createHubSpotAdapter({ token: TOKEN }), TypeError);
  assert.throws(() => createHubSpotAdapter({ transport: async () => {}, token: ' ' }), TypeError);
});

test('assign reads an existing contact by email first, then changes only its owner', async () => {
  const fake = transport([response(200, { id: '77', properties: { hubspot_owner_id: null } }), response(200, { id: '77' })]);
  const result = await adapter(fake).assign({ email: 'Dana@acme.example.com', ownerId: '1001', properties: { company: 'Acme' } });
  assert.deepEqual(result, { contactId: '77', created: false });
  assert.equal(fake.calls[0].method, 'GET');
  assert.equal(path(fake.calls[0].url), '/crm/v3/objects/contacts/Dana%40acme.example.com?idProperty=email&properties=hubspot_owner_id,notes_last_updated');
  assert.equal(fake.calls[1].method, 'PATCH');
  assert.equal(path(fake.calls[1].url), '/crm/v3/objects/contacts/Dana%40acme.example.com?idProperty=email');
  assert.deepEqual(fake.calls[1].body, { properties: { hubspot_owner_id: '1001' } });
  assert.equal(fake.calls[1].headers.authorization, `Bearer ${TOKEN}`);
});

test('assign creates the contact on a 404, with email, owner and the given properties', async () => {
  const fake = transport([response(404, { status: 'error', message: 'resource not found' }), response(201, { id: '78' })]);
  const result = await adapter(fake).assign({ email: 'dana@acme.example.com', ownerId: '1001', properties: { company: 'Acme' } });
  assert.deepEqual(result, { contactId: '78', created: true });
  assert.equal(fake.calls[1].method, 'POST');
  assert.equal(path(fake.calls[1].url), '/crm/v3/objects/contacts');
  assert.deepEqual(fake.calls[1].body, { properties: { email: 'dana@acme.example.com', hubspot_owner_id: '1001', company: 'Acme' } });
});

test('a create that conflicts (the contact appeared meanwhile) updates it instead of duplicating', async () => {
  const fake = transport([
    response(404, {}),
    response(409, { status: 'error', message: 'Contact already exists. Existing ID: 79', category: 'CONFLICT' }),
    response(200, { id: '79', properties: { hubspot_owner_id: null } }),
    response(200, { id: '79' }),
  ]);
  const result = await adapter(fake).assign({ email: 'dana@acme.example.com', ownerId: '1001' });
  assert.deepEqual(result, { contactId: '79', created: false });
  assert.deepEqual(fake.calls.map((c) => c.method), ['GET', 'POST', 'GET', 'PATCH']);
});

test('read returns owner and Last activity date, and null for an unknown email', async () => {
  const fake = transport([
    response(200, { id: '77', properties: { hubspot_owner_id: '1001', notes_last_updated: '2026-11-17T07:26:41.546Z' } }),
    response(404, '<html>Not Found</html>'),
  ]);
  const hubspot = adapter(fake);
  assert.deepEqual(await hubspot.read({ email: 'dana@acme.example.com' }), {
    contactId: '77', ownerId: '1001', lastActivityAt: '2026-11-17T07:26:41.546Z',
  });
  assert.equal(path(fake.calls[0].url), '/crm/v3/objects/contacts/dana%40acme.example.com?idProperty=email&properties=hubspot_owner_id,notes_last_updated');
  assert.equal(await hubspot.read({ email: 'x@y.example.com' }), null);
});

test('each failure carries a named code', async () => {
  const cases = [
    [response(401, { message: 'Authentication credentials not found' }), 'HUBSPOT_UNAUTHORIZED'],
    [response(403, { message: 'This app hasn\'t been granted all required scopes', errors: [{ context: { requiredGranularScopes: ['crm.objects.contacts.write'] } }] }), 'HUBSPOT_SCOPE_MISSING'],
    [response(400, { message: 'Property values were not valid', errors: [{ code: 'INVALID_OWNER_ID' }] }), 'HUBSPOT_INVALID_OWNER'],
    [response(400, { message: 'bad email' }), 'HUBSPOT_REJECTED'],
    [response(429, { message: 'You have reached your secondly limit.' }), 'HUBSPOT_RATE_LIMITED'],
    [response(502, 'bad gateway'), 'HUBSPOT_UNAVAILABLE'],
    [new Error('socket hang up'), 'HUBSPOT_UNAVAILABLE'],
  ];
  for (const [answer, code] of cases) {
    await assert.rejects(adapter(transport([answer])).assign({ email: 'a@b.example.com', ownerId: '1' }), { code }, code);
  }
});

test('a scope refusal names the scope HubSpot said was missing', async () => {
  const fake = transport([response(403, { message: 'missing scopes', errors: [{ context: { requiredGranularScopes: ['crm.objects.contacts.write'] } }] })]);
  await assert.rejects(adapter(fake).assign({ email: 'a@b.example.com', ownerId: '1' }), /crm\.objects\.contacts\.write/);
});

test('the token never appears in an error, even when HubSpot echoes it back', async () => {
  const fake = transport([response(401, { message: `invalid token ${TOKEN}` })]);
  await assert.rejects(adapter(fake).read({ email: 'a@b.example.com' }), (error) => {
    assert.ok(!error.message.includes(TOKEN));
    assert.match(error.message, /\[redacted:key\]/);
    return true;
  });
});

test('a hostile error body is cut short, so one answer cannot flood the journal', async () => {
  const fake = transport([response(500, 'x'.repeat(10000))]);
  await assert.rejects(adapter(fake).read({ email: 'a@b.example.com' }), (error) => error.message.length < 600);
});
