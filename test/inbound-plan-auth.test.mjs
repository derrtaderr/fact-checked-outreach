// The plan's bound counts every call a live tick makes, the startup scope check included; and a tick
// refused by the lock does not say "nothing was called" after it called auth.test.
// docs/INBOUND-SPEC.md, "Live mode and --plan" and "One tick at a time".
//
// Review pass 2, item 2: the plan printed "At most 0 HTTP call(s)" and the live tick made one
// (POST auth.test); the INBOUND_LOCKED refusal said "Nothing was called" after that same call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../src/cli.mjs';
import { T0 } from './helpers/inbound-world.mjs';

const ENV = { SIGNAL_DESK_HUBSPOT_TOKEN: 'pat-test', SIGNAL_DESK_SLACK_TOKEN: 'xoxb-test' };
const ROTATION = { response_minutes: 30, pools: { 'ae-round-robin': [{ id: 'ana', hubspot_owner_id: '1001', slack_user_id: 'U0001' }] } };
const reply = (status, body, headers = {}) => ({ status, headers: new Headers(headers), text: async () => JSON.stringify(body) });

async function box() {
  const cwd = mkdtempSync(join(tmpdir(), 'signal-desk-plan-auth-'));
  const output = [];
  const calls = [];
  const transport = async (url, options) => {
    calls.push(`${options.method} ${url}`);
    return reply(200, { ok: true }, { 'x-oauth-scopes': 'chat:write,im:write,im:history' });
  };
  const cli = (argv, extra = {}) => main({ argv, cwd, env: extra.env ?? {}, out: (l) => output.push(l), err: (l) => output.push(l), now: () => T0, httpTransport: transport });
  await cli(['run']);
  writeFileSync(join(cwd, 'inbound.json'), JSON.stringify(ROTATION));
  output.length = 0;
  return { cwd, output, calls, cli };
}

test('item 2: the plan lists and counts the scope check, so its bound covers a tick with nothing else to do', async () => {
  const { output, calls, cli } = await box();
  await cli(['inbound', '--live'], { env: ENV });   // assigns the run's lead; its clock is now running
  calls.length = 0;
  output.length = 0;
  await cli(['inbound', '--live', '--plan']);
  const plan = output.join('\n');
  assert.match(plan, /POST https:\/\/slack\.com\/api\/auth\.test/);
  const bound = Number(/At most (\d+) HTTP call/.exec(plan)?.[1]);

  await cli(['inbound', '--live'], { env: ENV });
  assert.ok(calls.length > 0);
  assert.ok(bound >= calls.length, `plan said at most ${bound}, the tick made ${calls.length}: ${calls.join(', ')}`);
});

test('item 2: a tick refused by the lock does not say nothing was called after it called auth.test', async () => {
  const { cwd, output, calls, cli } = await box();
  const state = join(cwd, 'runs', 'inbound');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'lock'), JSON.stringify({ pid: process.pid, host: hostname(), started_at: T0 }));

  assert.equal(await cli(['inbound', '--live'], { env: ENV }), 3, output.join('\n'));
  assert.deepEqual(calls.map((c) => c.split(' ')[1]), ['https://slack.com/api/auth.test']);
  assert.doesNotMatch(output.join('\n'), /Nothing was called/);
  assert.match(output.join('\n'), /auth\.test/);
});
