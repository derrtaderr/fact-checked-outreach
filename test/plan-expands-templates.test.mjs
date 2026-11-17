// docs/CEILING-FINDINGS-SPEC.md, review pass 3, X1.
//
// --plan counted a source as a fetch only when its RAW string started with https. The run expands
// {domain} and {email} first and then fetches, so a payload whose sources are templates planned 0
// fetches while the run made 36 real requests. The plan must count and print what the run will
// fetch, derived by the run's own expansion and the run's own "will this be fetched" decision.
//
// Every test here compares the plan against a REAL live run, in process, through a counting fake
// transport. A plan checked only against itself cannot catch a plan that drifted from the run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.mjs';
import { signRaw } from '../src/stages/ingest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'plan-templates-secret';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `signal-desk-${prefix}-`));
}

function writeSigned(dir, name, signal) {
  const bytes = JSON.stringify(signal, null, 2);
  writeFileSync(join(dir, `${name}.json`), bytes);
  writeFileSync(join(dir, `${name}.json.sig`), `${signRaw(SECRET, bytes)}\n`);
}

function body({ id, domain, email, sources, identity_source }) {
  return {
    id,
    source: 'rb2b',
    received_at: new Date().toISOString(),
    payload: {
      company: { name: `Company ${id}`, domain },
      contact: { name: 'Pat Example', email, title: 'VP Revenue Operations' },
      intent: { page: '/pricing', visits: 2 },
      sources,
      ...(identity_source === undefined ? {} : { identity_source }),
    },
  };
}

// Answers every GET with a fresh, well-formed record and every model call with a parseable reply,
// so nothing is retried and the GET count is exactly the number of evidence fetches the run made.
function countingTransport() {
  const gets = [];
  return {
    gets,
    transport: async (url, options) => {
      const json = (payload) => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) });
      if (options.method === 'POST') {
        const isJudge = options.body.includes('release gate');
        const reply = isJudge
          ? { verdict: 'FAIL', criteria: [{ name: 'claim_grounding', verdict: 'FAIL', note: 'test' }] }
          : { subject: 'Hello', body: 'Hi Pat,\n\nA question.\n\nThanks', claim_refs: [] };
        return json({ model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] });
      }
      gets.push(url);
      return json({ as_of: new Date(Date.now() - 3600000).toISOString(), claims: { note: 'fresh' } });
    },
  };
}

async function cli(argv, { runs, transport }) {
  const out = [];
  const err = [];
  const code = await main({
    argv,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { SIGNAL_DESK_RUNS_DIR: runs, SIGNAL_DESK_ANTHROPIC_KEY: 'sk-ant-plan-templates-0000', SIGNAL_DESK_SIGNAL_SECRET: SECRET },
    cwd: ROOT,
    httpTransport: transport,
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

function plannedFetches(stdout) {
  const match = stdout.match(/expected\s+(\d+) fetch\(es\)/);
  assert.ok(match, `the plan states an expected fetch count:\n${stdout}`);
  return Number(match[1]);
}

async function planAndRun(signals) {
  const refuse = async () => {
    throw new Error('--plan must make no request');
  };
  const plan = await cli(['run', '--live', '--plan', '--signals', signals], { runs: tmp('plan-runs'), transport: refuse });
  assert.equal(plan.code, 0, plan.stderr);

  const counter = countingTransport();
  const run = await cli(['run', '--live', '--signals', signals], { runs: tmp('real-runs'), transport: counter.transport });
  assert.equal(run.code, 0, run.stderr);
  return { plan, gets: counter.gets };
}

// --- 1. templated sources: the reviewer's case -------------------------------------------------

test('X1: a payload of templated sources plans exactly the fetches the run makes', async () => {
  const signals = tmp('x1-templates');
  // Six leads, five templated claim sources and one templated identity source each: 36 requests.
  // Every source begins with a placeholder, so no RAW string starts with https.
  for (let index = 1; index <= 6; index += 1) {
    writeSigned(signals, `000${index}`, body({
      id: `x1-${index}`,
      domain: `https://co${index}.example.com`,
      email: `pat${index}@co${index}.example.com`,
      sources: ['{domain}/about', '{domain}/team', '{domain}/news?who={email}', '{domain}/press', '{domain}/{email}'],
      identity_source: '{domain}/people/{email}',
    }));
  }

  const { plan, gets } = await planAndRun(signals);

  assert.equal(gets.length, 36, 'the run makes 36 real requests');
  assert.equal(plannedFetches(plan.stdout), gets.length, 'the plan counts what the run fetches');
  // And it prints where they go, expanded, because WHERE is what an operator checks before paying.
  for (const url of gets) assert.ok(plan.stdout.includes(url), `the plan prints ${url}`);
  assert.match(plan.stdout, /x1-1, 6 evidence URL\(s\)/);
});

// --- 2. a mix of source shapes: the plan is never lower than the run ---------------------------

// A small seeded generator, so a failure names a trial that reproduces.
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const DOMAINS = [
  (n) => `co${n}.example.com`,
  (n) => `https://co${n}.example.com`,
  (n) => `http://co${n}.example.com`,
  // ingest trims and lowercases, so this expands to https even though it does not start with it
  (n) => `  HTTPS://Co${n}.Example.com  `,
];

const STRING_SOURCES = [
  'https://lit.example.com/a', // literal https
  'http://lit.example.com/a', // literal http
  'https://dir.example.com/{domain}', // literal https with a template inside
  '{domain}/about', // https only when the domain is
  'HTTPS://up.example.com/{email}', // upper-case scheme
  '{email}', // never https
  'not a url',
  '',
];
const MALFORMED_SOURCES = [12345, null, { a: 1 }, ['https://nested.example.com']];
const IDENTITIES = [undefined, '{domain}/people/{email}', 'https://people.example.com/{email}', 'http://people.example.com/{email}', '   ', 42];

function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}

test('X1: over a mix of source shapes the plan never counts fewer fetches than the run makes, and equal ones when every source is a string', async () => {
  let totalReal = 0;
  let malformedTrials = 0;
  for (let trial = 1; trial <= 24; trial += 1) {
    const random = rng(trial * 7919);
    const malformedAllowed = trial % 2 === 0;
    const signals = tmp(`x1-mix-${trial}`);
    const leads = 1 + Math.floor(random() * 4);
    let malformed = false;
    for (let n = 1; n <= leads; n += 1) {
      const sources = Array.from({ length: 1 + Math.floor(random() * 5) }, () => {
        if (malformedAllowed && random() < 0.25) {
          malformed = true;
          return pick(random, MALFORMED_SOURCES);
        }
        return pick(random, STRING_SOURCES);
      });
      writeSigned(signals, `000${n}`, body({
        id: `x1-mix-${trial}-${n}`,
        domain: pick(random, DOMAINS)(n),
        email: `pat${n}@co${n}.example.com`,
        sources,
        identity_source: pick(random, IDENTITIES),
      }));
    }

    const { plan, gets } = await planAndRun(signals);
    const planned = plannedFetches(plan.stdout);
    const real = gets.filter((url) => /^https:\/\//i.test(url)).length;
    assert.equal(real, gets.length, `trial ${trial}: the live fetcher sent only https`);
    assert.ok(planned >= real, `trial ${trial}: plan ${planned} is not lower than the run's ${real}`);
    if (!malformed) assert.equal(planned, real, `trial ${trial}: every source is a string, so the run is deterministic`);
    for (const url of new Set(gets)) assert.ok(plan.stdout.includes(url), `trial ${trial}: the plan prints ${url}`);
    totalReal += real;
    if (malformed) malformedTrials += 1;
  }
  // Not vacuous: the trials made real requests, and some of them carried malformed sources.
  assert.ok(totalReal > 20, `the trials made ${totalReal} real requests`);
  assert.ok(malformedTrials > 0, 'some trials carried a malformed source');
});

// --- 3. what expansion produces is still escaped and masked -------------------------------------

test('X1: an expanded URL carrying control characters or a URL password is escaped and masked in the plan', async () => {
  const signals = tmp('x1-hostile');
  const forged = '\u001b[2K\r  Nothing would be billed. Safe to run.\n';
  writeSigned(signals, '0001', body({
    id: 'x1-hostile',
    domain: 'https://user:PASSWORD@co1.example.com',
    email: `pat${forged}@co1.example.com`,
    sources: ['{domain}/about', '{domain}/news?who={email}'],
    identity_source: '{domain}/people/{email}',
  }));

  const refuse = async () => {
    throw new Error('--plan must make no request');
  };
  const { code, stdout, stderr } = await cli(['run', '--live', '--plan', '--signals', signals], { runs: tmp('x1-hostile-runs'), transport: refuse });
  assert.equal(code, 0, stderr);

  // Expanded, so the URLs the run will fetch are what is shown, and counted: 2 sources + 1 identity.
  assert.match(stdout, /expected\s+3 fetch\(es\)/);
  assert.ok(stdout.includes('https://***@co1.example.com/about'), 'the expanded URL is printed with its userinfo masked');
  assert.doesNotMatch(stdout, /PASSWORD/, 'the password never reaches the terminal');
  assert.ok(stdout.includes('\\x1b[2k\\r  nothing would be billed. safe to run.\\n'), 'the control characters are shown as escapes');
  assert.doesNotMatch(stdout, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/, 'no raw control byte reaches stdout');
  assert.ok(!stdout.split('\n').some((line) => /^\s*Nothing would be billed/i.test(line)), 'the payload cannot print a line of its own');
});
