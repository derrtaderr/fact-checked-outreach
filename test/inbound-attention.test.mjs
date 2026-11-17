// A tick that leaves something for a person says so in its exit code. docs/INBOUND-SPEC.md, "Exit codes".
//
// Review pass 1, I5: a tick in which every lead failed (a 401 on every HubSpot write) exited 0, so a
// cron job could not alarm; a lead parked NO_REP_RESPONDED was printed once and then never again; and
// a Slack token without im:history made every uncertain post SLACK_UNCONFIRMED forever, found only
// after a write.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../src/cli.mjs';
import { planCalls } from '../src/inbound/plan.mjs';
import { Journal } from '../src/inbound/journal.mjs';
import { eventOf, rotationOf, world, run, T0, minutesAfter } from './helpers/inbound-world.mjs';

const ENV = { SIGNAL_DESK_HUBSPOT_TOKEN: 'pat-test', SIGNAL_DESK_SLACK_TOKEN: 'xoxb-test' };
const ROTATION = { response_minutes: 30, pools: { 'ae-round-robin': [{ id: 'ana', hubspot_owner_id: '1001', slack_user_id: 'U0001' }] } };
const reply = (status, body, headers = {}) => ({ status, headers: new Headers(headers), text: async () => JSON.stringify(body) });

async function box() {
  const cwd = mkdtempSync(join(tmpdir(), 'signal-desk-attention-'));
  const output = [];
  const cli = (argv, extra = {}) => main({ argv, cwd, env: extra.env ?? {}, out: (l) => output.push(l), err: (l) => output.push(l), now: () => extra.now ?? T0, httpTransport: extra.httpTransport });
  await cli(['run']);
  writeFileSync(join(cwd, 'inbound.json'), JSON.stringify(ROTATION));
  output.length = 0;
  return { cwd, output, cli };
}

test('I5: a tick in which a lead failed (HubSpot 401 on every write) exits 4 so cron can alarm', async () => {
  const { output, cli } = await box();
  const transport = async (url) => (new URL(url).hostname === 'slack.com'
    ? reply(200, { ok: true }, { 'x-oauth-scopes': 'chat:write,im:write,im:history' })
    : reply(401, { message: 'Authentication credentials not found' }));
  const code = await cli(['inbound', '--live'], { env: ENV, httpTransport: transport });
  assert.equal(code, 4, output.join('\n'));
  assert.match(output.join('\n'), /CRM_PENDING/);
  assert.match(output.join('\n'), /needs a person|exit 4/i);
});

test('I5: a clean fixture tick still exits 0', async () => {
  const { output, cli } = await box();
  assert.equal(await cli(['inbound', '--at', T0]), 0, output.join('\n'));
});

test('I5: a parked NO_REP_RESPONDED lead is listed on every tick, with the way out, until a person acts', async () => {
  const w = world({ rotation: rotationOf({ 'ae-round-robin': ['ana'] }), owners: ['o-ana', 'o-human'] });
  await run(w, [eventOf(1)]);
  assert.equal((await run(w, [], minutesAfter(31))).outcomes[0].status, 'NO_REP_RESPONDED');

  const again = await run(w, [], minutesAfter(62));
  assert.equal(again.outcomes.length, 1, 'still listed');
  assert.equal(again.outcomes[0].status, 'NO_REP_RESPONDED');
  assert.match(again.outcomes[0].detail, /HubSpot/);

  const planned = await planCalls({ events: [], rotation: w.rotation, journal: Journal.open(w.path, { readOnly: true }), at: minutesAfter(70) });
  assert.equal(planned.outcomes[0].status, 'NO_REP_RESPONDED', 'the plan lists it too');

  w.hubspot.setOwner('contact1@co1.example.com', 'o-human');
  const acted = await run(w, [], minutesAfter(93));
  assert.equal(acted.outcomes[0].status, 'OWNER_CHANGED');
  assert.equal((await run(w, [], minutesAfter(124))).outcomes.length, 0, 'no longer listed once a person acted');
});

test('I5: a live tick with a Slack token missing im:history refuses before any write', async () => {
  const { cwd, output, cli } = await box();
  const calls = [];
  const transport = async (url, options) => {
    calls.push(`${options.method} ${url}`);
    return reply(200, { ok: true }, { 'x-oauth-scopes': 'chat:write,im:write' });
  };
  const code = await cli(['inbound', '--live'], { env: ENV, httpTransport: transport });
  assert.equal(code, 2, output.join('\n'));
  assert.match(output.join('\n'), /SLACK_SCOPE_MISSING/);
  assert.match(output.join('\n'), /im:history/);
  assert.ok(calls.every((c) => c.includes('slack.com/api/auth.test')), calls.join('\n'));
  assert.ok(!existsSync(join(cwd, 'runs', 'inbound')), 'nothing was written');
});
