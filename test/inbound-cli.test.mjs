// The inbound verb, end to end through main(). docs/INBOUND-SPEC.md, "Live mode and --plan".
//
// Fixture mode runs on the fakes and the committed synthetic rotation. Live mode is driven with an
// injected fake transport that answers as HubSpot and Slack do, so the whole live path, including the
// order of the credential checks, runs without a socket.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../src/cli.mjs';

const HS_TOKEN = 'pat-na2-canary-HUBSPOT-DO-NOT-LOG-91ab';
const SL_TOKEN = 'xoxb-canary-SLACK-DO-NOT-LOG-44cd';
const T0 = '2026-03-01T09:00:00.000Z';
const later = (minutes) => new Date(Date.parse(T0) + minutes * 60000).toISOString();

function sandbox() {
  const cwd = mkdtempSync(join(tmpdir(), 'signal-desk-inbound-cli-'));
  return { cwd, env: {} };
}

async function cli(box, argv, extra = {}) {
  const lines = { out: [], err: [] };
  const code = await main({
    argv,
    cwd: box.cwd,
    env: box.env,
    out: (line) => lines.out.push(line),
    err: (line) => lines.err.push(line),
    now: () => extra.now ?? T0,
    httpTransport: extra.httpTransport,
  });
  return { code, out: lines.out.join('\n'), err: lines.err.join('\n') };
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

function latestHandoff(box) {
  const runs = join(box.cwd, 'runs');
  const run = readFileSync(join(runs, 'latest'), 'utf8').trim();
  const dir = join(runs, run, 'handoffs');
  const name = readdirSync(dir).find((n) => n.endsWith('.json'));
  return join(dir, name);
}

function writeRotation(box, rotation) {
  const path = join(box.cwd, 'inbound.json');
  writeFileSync(path, JSON.stringify(rotation));
  return path;
}

const LIVE_ROTATION = {
  response_minutes: 30,
  pools: {
    'ae-round-robin': [
      { id: 'ana', hubspot_owner_id: '1001', slack_user_id: 'U0001' },
      { id: 'ben', hubspot_owner_id: '1002', slack_user_id: 'U0002' },
    ],
  },
};

// Answers as HubSpot and Slack answered (or are documented to answer), and records every call.
function fakeServices() {
  const contacts = new Map();
  const calls = [];
  let ts = 0;
  const reply = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const transport = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body, auth: options.headers?.authorization });
    const u = new URL(url);
    if (u.hostname === 'slack.com') {
      ts += 1;
      return reply(200, { ok: true, ts: `17.${ts}`, channel: 'D1' });
    }
    const email = decodeURIComponent(u.pathname.split('/').pop());
    if (options.method === 'PATCH') {
      if (!contacts.has(email)) return reply(404, { message: 'resource not found' });
      contacts.get(email).owner = JSON.parse(options.body).properties.hubspot_owner_id;
      return reply(200, { id: contacts.get(email).id });
    }
    if (options.method === 'POST') {
      const props = JSON.parse(options.body).properties;
      contacts.set(props.email, { id: String(500 + contacts.size), owner: props.hubspot_owner_id });
      return reply(201, { id: contacts.get(props.email).id });
    }
    const contact = contacts.get(email);
    return contact ? reply(200, { id: contact.id, properties: { hubspot_owner_id: contact.owner, notes_last_updated: null } }) : reply(404, {});
  };
  return { transport, calls, contacts };
}

test('fixture mode: the approved lead is assigned from the synthetic rotation and its rep told', async () => {
  const box = sandbox();
  assert.equal((await cli(box, ['run'])).code, 0);
  const result = await cli(box, ['inbound', '--at', T0]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /sig-1001\s+lead-29e94419ba7e\s+ASSIGNED\s+ana/);
  assert.match(result.out, /fixture mode/);
  assert.match(result.out, /Nothing was sent to a prospect/);
  const slack = JSON.parse(readFileSync(join(box.cwd, 'runs', 'inbound-fixture', 'slack.json'), 'utf8'));
  assert.equal(slack.posts.length, 1);
  assert.ok(existsSync(join(box.cwd, 'runs', 'inbound-fixture', 'journal.jsonl')));
});

test('fixture mode: a re-run assigns nothing new, and 31 minutes later the lead moves to the next rep', async () => {
  const box = sandbox();
  await cli(box, ['run']);
  await cli(box, ['inbound', '--at', T0]);
  const again = await cli(box, ['inbound', '--at', later(10)]);
  assert.match(again.out, /CLOCK_RUNNING/);
  const moved = await cli(box, ['inbound', '--at', later(31)]);
  assert.match(moved.out, /REASSIGNED\s+ben/);
  const hubspot = JSON.parse(readFileSync(join(box.cwd, 'runs', 'inbound-fixture', 'hubspot.json'), 'utf8'));
  assert.equal(hubspot.contacts.length, 1);
});

test('inbound with no runs says to run first', async () => {
  const box = sandbox();
  const result = await cli(box, ['inbound']);
  assert.equal(result.code, 2);
  assert.match(result.err, /no runs found/);
});

test('--at must be an instant, and is refused in live mode', async () => {
  const box = sandbox();
  await cli(box, ['run']);
  assert.match((await cli(box, ['inbound', '--at', 'soon'])).err, /INBOUND_AT_INVALID/);
  const live = await cli(box, ['inbound', '--live', '--at', T0]);
  assert.equal(live.code, 2);
  assert.match(live.err, /INBOUND_AT_LIVE/);
});

test('live without tokens refuses before reading anything, and writes nothing', async () => {
  const box = sandbox();
  await cli(box, ['run']);
  const before = walk(join(box.cwd, 'runs')).length;
  const noHub = await cli(box, ['inbound', '--live']);
  assert.equal(noHub.code, 2);
  assert.match(noHub.err, /INBOUND_HUBSPOT_TOKEN_MISSING/);
  box.env.SIGNAL_DESK_HUBSPOT_TOKEN = HS_TOKEN;
  const noSlack = await cli(box, ['inbound', '--live']);
  assert.match(noSlack.err, /INBOUND_SLACK_TOKEN_MISSING/);
  assert.equal(walk(join(box.cwd, 'runs')).length, before);
});

test('live without a rotation file refuses ROTATION_CONFIG_MISSING; it never falls back to the synthetic reps', async () => {
  const box = sandbox();
  await cli(box, ['run']);
  box.env.SIGNAL_DESK_HUBSPOT_TOKEN = HS_TOKEN;
  box.env.SIGNAL_DESK_SLACK_TOKEN = SL_TOKEN;
  const services = fakeServices();
  const result = await cli(box, ['inbound', '--live'], { httpTransport: services.transport });
  assert.equal(result.code, 2);
  assert.match(result.err, /ROTATION_CONFIG_MISSING/);
  assert.equal(services.calls.length, 0);
});

test('a malformed rotation file is refused before any call', async () => {
  const box = sandbox();
  await cli(box, ['run']);
  writeRotation(box, { response_minutes: 'soon', pools: {} });
  const result = await cli(box, ['inbound']);
  assert.equal(result.code, 2);
  assert.match(result.err, /ROTATION_CONFIG_INVALID/);
});

test('live: owner written in HubSpot, rep told in Slack, and no token anywhere in output or on disk', async () => {
  const box = sandbox();
  await cli(box, ['run']);
  writeRotation(box, LIVE_ROTATION);
  box.env.SIGNAL_DESK_HUBSPOT_TOKEN = HS_TOKEN;
  box.env.SIGNAL_DESK_SLACK_TOKEN = SL_TOKEN;
  const services = fakeServices();
  const result = await cli(box, ['inbound', '--live'], { httpTransport: services.transport });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /ASSIGNED\s+ana/);
  assert.deepEqual(services.calls.map((c) => `${c.method} ${new URL(c.url).hostname}`), [
    'GET api.hubapi.com', 'POST api.hubapi.com', 'POST slack.com',
  ]);
  assert.equal(services.contacts.get('dana@acme.test').owner, '1001');
  assert.equal(services.calls[0].auth, `Bearer ${HS_TOKEN}`);
  assert.equal(services.calls[2].auth, `Bearer ${SL_TOKEN}`);

  const everything = [result.out, result.err, ...walk(join(box.cwd, 'runs')).map((f) => readFileSync(f, 'utf8'))].join('\n');
  assert.ok(!everything.includes(HS_TOKEN), 'the HubSpot token is nowhere');
  assert.ok(!everything.includes(SL_TOKEN), 'the Slack token is nowhere');
  assert.ok(existsSync(join(box.cwd, 'runs', 'inbound', 'journal.jsonl')), 'live state is kept apart from fixture state');
});

test('live: a HubSpot 401 that echoes the token is recorded with the token removed', async () => {
  const box = sandbox();
  await cli(box, ['run']);
  writeRotation(box, LIVE_ROTATION);
  box.env.SIGNAL_DESK_HUBSPOT_TOKEN = HS_TOKEN;
  box.env.SIGNAL_DESK_SLACK_TOKEN = SL_TOKEN;
  const transport = async () => ({ status: 401, text: async () => JSON.stringify({ message: `bad token ${HS_TOKEN}` }) });
  const result = await cli(box, ['inbound', '--live'], { httpTransport: transport });
  assert.match(result.out, /CRM_PENDING/);
  assert.match(result.out, /HUBSPOT_UNAUTHORIZED/);
  const everything = [result.out, result.err, ...walk(join(box.cwd, 'runs')).map((f) => readFileSync(f, 'utf8'))].join('\n');
  assert.ok(!everything.includes(HS_TOKEN));
});

test('live --plan needs no token, contacts nothing, writes nothing, and lists every call it would make', async () => {
  const box = sandbox();
  await cli(box, ['run']);
  writeRotation(box, LIVE_ROTATION);
  const before = walk(join(box.cwd, 'runs')).sort();
  let contacted = 0;
  const result = await cli(box, ['inbound', '--live', '--plan'], { httpTransport: async () => { contacted += 1; } });
  assert.equal(result.code, 0, result.err);
  assert.equal(contacted, 0);
  assert.deepEqual(walk(join(box.cwd, 'runs')).sort(), before);
  assert.match(result.out, /sig-1001 .*would go to ana/);
  assert.match(result.out, /PATCH https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/contacts\/dana%40acme\.test\?idProperty=email/);
  assert.match(result.out, /POST https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/contacts/);
  assert.match(result.out, /POST https:\/\/slack\.com\/api\/chat\.postMessage to U0001/);
  assert.match(result.out, /Nothing was contacted and nothing was written/);
});

test('live --plan after an assignment shows the clock read it would make and who would get the lead', async () => {
  const box = sandbox();
  await cli(box, ['run']);
  writeRotation(box, LIVE_ROTATION);
  box.env.SIGNAL_DESK_HUBSPOT_TOKEN = HS_TOKEN;
  box.env.SIGNAL_DESK_SLACK_TOKEN = SL_TOKEN;
  await cli(box, ['inbound', '--live'], { httpTransport: fakeServices().transport });
  const plan = await cli(box, ['inbound', '--live', '--plan'], { now: later(45) });
  assert.match(plan.out, /GET https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/contacts\/dana%40acme\.test\?idProperty=email&properties=hubspot_owner_id,notes_last_updated/);
  assert.match(plan.out, /if untouched, would reassign to ben/);
});

test('a hostile payload in the handoff reaches the terminal escaped, in a tick and in a plan', async () => {
  const box = sandbox();
  await cli(box, ['run']);
  const path = latestHandoff(box);
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  artifact.to = 'dana@acme.test\u001b[2K\rFORGED ALL CLEAR';
  writeFileSync(path, JSON.stringify(artifact));
  // A second export whose lead id is hostile: it has no ingest entry, so it is refused, and the refusal
  // prints the id.
  writeFileSync(path.replace(/\.json$/, '-copy.json'), JSON.stringify({ ...artifact, lead_id: 'lead-x\u001b]0;pwned\u0007\rFORGED' }));
  writeRotation(box, LIVE_ROTATION);
  const tick = await cli(box, ['inbound', '--at', T0]);
  const plan = await cli(box, ['inbound', '--live', '--plan']);
  for (const text of [tick.out, tick.err, plan.out, plan.err]) {
    assert.doesNotMatch(text, /\u001b|\r/);
  }
  assert.match(tick.out, /SIGNAL_ID_UNKNOWN/);
  assert.match(tick.out, /lead-x\\x1b\]0;pwned\\x07\\rFORGED/, 'the hostile id is shown, escaped');
  assert.match(plan.out, /dana%40acme\.test%1B%5B2K%0DFORGED/, 'in a URL it is percent-encoded, which is also inert');
});

test('an eml handoff is refused by name; only the json export carries the brief', async () => {
  const box = sandbox();
  await cli(box, ['run']);
  const path = latestHandoff(box);
  renameSync(path, path.replace(/\.json$/, '.eml'));
  const result = await cli(box, ['inbound', '--at', T0]);
  assert.match(result.out, /HANDOFF_FORMAT_UNSUPPORTED/);
});

test('inbound refuses flags it does not take', async () => {
  const box = sandbox();
  const result = await cli(box, ['inbound', '--max-leads', '3']);
  assert.equal(result.code, 2);
  assert.match(result.err, /unknown flag --max-leads/);
  assert.match(result.err, /inbound accepts: --live, --plan, --rotation, --at/);
});

test('a tampered journal is refused and nothing is called', async () => {
  const box = sandbox();
  await cli(box, ['run']);
  await cli(box, ['inbound', '--at', T0]);
  const journal = join(box.cwd, 'runs', 'inbound-fixture', 'journal.jsonl');
  writeFileSync(journal, readFileSync(journal, 'utf8').replace('"ana"', '"ben"'));
  const result = await cli(box, ['inbound', '--at', later(31)]);
  assert.equal(result.code, 1);
  assert.match(result.err, /JOURNAL_TAMPERED/);
});

