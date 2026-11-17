// --plan is the tick, run against adapters that call nothing. docs/INBOUND-SPEC.md, "Live mode and --plan".
//
// Review pass 1, B4: the plan walked the journal itself, took capacity once and handled clocks before
// new leads, while the tick does neither, so a plan said 2 calls where the tick made 4. The plan now
// runs the engine's own tick on an in-memory copy of the journal, with adapters that record and answer
// as the plan assumes (every write succeeds, every lead past its window is untouched, an earlier post
// is not found). So its order and capacity cannot drift from the tick's, and its call list is an
// upper bound that is exact when HubSpot and Slack answer as assumed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planCalls } from '../src/inbound/plan.mjs';
import { tick } from '../src/inbound/engine.mjs';
import { Journal } from '../src/inbound/journal.mjs';
import { main } from '../src/cli.mjs';
import { eventOf, rotationOf, world, run, T0, minutesAfter } from './helpers/inbound-world.mjs';

const asText = (op) => (op.op === 'assign' ? `assign ${op.email} ${op.ownerId}` : op.op === 'read' ? `read ${op.email}` : `${op.op} ${op.channel}`);

function recording(calls, hubspot, slack) {
  return {
    hubspot: {
      assign: (args) => { calls.push(asText({ op: 'assign', ...args })); return hubspot.assign(args); },
      read: (args) => { calls.push(asText({ op: 'read', ...args })); return hubspot.read(args); },
    },
    slack: {
      post: (message) => { calls.push(asText({ op: 'post', ...message })); return slack.post(message); },
      find: (query) => { calls.push(asText({ op: 'find', ...query })); return slack.find(query); },
    },
  };
}

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

function scenario(seed, { quiet }) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const rep = (id) => ({ id, hubspot_owner_id: `o-${id}`, slack_user_id: `U-${id}`, ...(r() < 0.5 ? { capacity: pick([1, 2]) } : {}), ...(r() < 0.1 ? { away: true } : {}) });
  const rotation = rotationOf({ 'ae-round-robin': ['ana', 'ben', 'cy'].map(rep), 'sdr-queue': ['dee', 'eve'].map(rep) }, 30);
  const count = 1 + Math.floor(r() * 5);
  const events = Array.from({ length: count }, (_, i) => eventOf(i + 1, { pool: pick(['ae-round-robin', 'sdr-queue']) }));
  const first = Math.floor(r() * (count + 1));
  return {
    rotation,
    events,
    history: [
      { at: T0, events: events.slice(0, first) },
      { at: minutesAfter(Math.floor(r() * 45)), events: events.slice(0, first + Math.floor(r() * (count - first + 1))) },
    ],
    touch: quiet ? () => false : () => r() < 0.3,
    human: quiet ? () => false : () => r() < 0.1,
    final: minutesAfter(30 + Math.floor(r() * 80)),
  };
}

// The disk is not under test here, and a durable append costs an fsync or three.
const FAST = { fsync: () => {} };

async function compare(seed, quiet) {
  const s = scenario(seed, { quiet });
  const w = world({ rotation: s.rotation, owners: ['o-ana', 'o-ben', 'o-cy', 'o-dee', 'o-eve', 'o-human'] });
  for (const step of s.history) await run(w, step.events, step.at, FAST);
  for (const contact of w.hubspot.contacts()) {
    if (s.touch()) w.hubspot.logActivity(contact.email, minutesAfter(50));
    if (s.human()) w.hubspot.setOwner(contact.email, 'o-human');
  }
  const planned = await planCalls({ events: s.events, rotation: s.rotation, journal: Journal.open(w.path, { readOnly: true, ...FAST }), at: s.final });
  const live = [];
  const adapters = recording(live, w.hubspot, w.slack);
  await tick({ events: s.events, rotation: s.rotation, journal: Journal.open(w.path, FAST), ...adapters, now: () => s.final });
  return { planned: planned.calls.map(asText), possible: planned.possible.map(asText), live };
}

test('B4: for generated scenarios the planned call list is never shorter than the live one', async () => {
  for (let seed = 1; seed <= 150; seed += 1) {
    const { planned: definite, possible, live } = await compare(seed, false);
    const planned = [...definite, ...possible];
    assert.ok(planned.length >= live.length, `seed ${seed}: planned ${planned.length} < live ${live.length}\nplanned ${planned.join(', ')}\nlive    ${live.join(', ')}`);
  }
});

test('B4: when HubSpot and Slack answer as the plan assumes, the plan is exactly the tick', async () => {
  for (let seed = 1; seed <= 150; seed += 1) {
    const { planned, live } = await compare(seed, true);
    assert.deepEqual(planned, live, `seed ${seed}`);
  }
});

// The probe that found it: two leads in one pool, capacity 1 each; one touched, one not, 31 minutes on.
test('B4: the CLI plan bounds the HTTP calls of the live tick that follows it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'signal-desk-plan-parity-'));
  const output = [];
  const cli = (argv, extra = {}) => main({ argv, cwd, env: extra.env ?? {}, out: (l) => output.push(l), err: (l) => output.push(l), now: () => extra.now ?? T0, httpTransport: extra.httpTransport });
  await cli(['run']);
  await cli(['queue']);
  const hash = /draft-[0-9a-f]+/.exec(output.join('\n'))[0];
  await cli(['approve', hash, '--by', 'reviewer']);
  await cli(['run']);
  const runs = join(cwd, 'runs');
  const handoffs = join(runs, readFileSync(join(runs, 'latest'), 'utf8').trim(), 'handoffs');
  for (const name of readdirSync(handoffs)) {
    const artifact = JSON.parse(readFileSync(join(handoffs, name), 'utf8'));
    writeFileSync(join(handoffs, name), JSON.stringify({ ...artifact, owner: 'ae-round-robin' }));
  }
  writeFileSync(join(cwd, 'inbound.json'), JSON.stringify({ response_minutes: 30, pools: { 'ae-round-robin': [
    { id: 'ana', hubspot_owner_id: '1001', slack_user_id: 'U0001', capacity: 1 },
    { id: 'ben', hubspot_owner_id: '1002', slack_user_id: 'U0002', capacity: 1 },
  ] } }));

  const contacts = new Map();
  const calls = [];
  let ts = 0;
  const reply = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const transport = async (url, options) => {
    calls.push(`${options.method} ${url}`);
    const u = new URL(url);
    if (u.hostname === 'slack.com') { ts += 1; return reply(200, { ok: true, ts: `17.${ts}`, channel: { id: 'D1' }, messages: [] }); }
    if (options.method === 'POST') {
      const p = JSON.parse(options.body).properties;
      contacts.set(p.email, { id: String(500 + contacts.size), owner: p.hubspot_owner_id, act: null });
      return reply(201, { id: contacts.get(p.email).id });
    }
    const email = decodeURIComponent(u.pathname.split('/').pop());
    const c = contacts.get(email);
    if (options.method === 'PATCH') { c.owner = JSON.parse(options.body).properties.hubspot_owner_id; return reply(200, { id: c.id }); }
    return c ? reply(200, { id: c.id, properties: { hubspot_owner_id: c.owner, notes_last_updated: c.act } }) : reply(404, {});
  };
  const env = { SIGNAL_DESK_HUBSPOT_TOKEN: 'pat-test', SIGNAL_DESK_SLACK_TOKEN: 'xoxb-test' };
  assert.equal(await cli(['inbound', '--live'], { env, httpTransport: transport }), 0, output.join('\n'));
  const anas = [...contacts.values()].find((c) => c.owner === '1001');
  anas.act = minutesAfter(5);

  output.length = 0;
  await cli(['inbound', '--live', '--plan'], { now: minutesAfter(31) });
  const plan = output.join('\n');
  const bound = Number(/At most (\d+) (?:HTTP )?call/.exec(plan)?.[1]);
  const before = calls.length;
  await cli(['inbound', '--live'], { env, httpTransport: transport, now: minutesAfter(31) });
  assert.ok(bound >= calls.length - before, `plan said at most ${bound}, the tick made ${calls.length - before}:\n${plan}`);
});
